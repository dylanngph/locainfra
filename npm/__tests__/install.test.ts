import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "..", "..", "install.sh");
const GOOD = "0.1.0-rc.0";
const BAD = "9.9.9";
const TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
];

const hostOs = process.platform === "darwin" ? "darwin" : "linux";
const hostArch = process.arch === "arm64" ? "arm64" : "x64";

let root: string;
let tarball: Uint8Array;
let server: ReturnType<typeof Bun.serve>;
const requested: string[] = [];

/** SHA256SUMS listing every target's asset, all pointing at `hash`. */
const sums = (version: string, hash: string) =>
	TARGETS.map((t) => `${hash}  locastack-${version}-${t}.tar.gz`).join("\n") +
	"\n";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "locastack-install-"));
	const stage = join(root, "stage");
	mkdirSync(stage);
	writeFileSync(
		join(stage, "locastack"),
		`#!/bin/sh\necho "locastack ${GOOD}"\n`,
	);
	Bun.spawnSync([
		"tar",
		"-czf",
		join(root, "asset.tar.gz"),
		"-C",
		stage,
		"locastack",
	]);
	tarball = new Uint8Array(readFileSync(join(root, "asset.tar.gz")));
	const hash = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			requested.push(path);
			if (path === "/api/latest")
				return Response.json({ tag_name: `v${GOOD}`, name: "x" });
			const match = path.match(/^\/download\/v([^/]+)\/(.+)$/);
			if (!match) return new Response("not found", { status: 404 });
			const [, version, file] = match;
			if (file === "SHA256SUMS") {
				return new Response(
					sums(version ?? "", version === BAD ? "0".repeat(64) : hash),
				);
			}
			if (file?.startsWith(`locastack-${version}-`))
				return new Response(tarball);
			return new Response("not found", { status: 404 });
		},
	});
});

afterAll(() => {
	server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

/** Runs install.sh against the fake release server (async: the server shares this event loop). */
async function install(dir: string, env: Record<string, string>) {
	const proc = Bun.spawn(["sh", INSTALL_SH], {
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: root,
			SHELL: "/bin/zsh",
			LOCASTACK_INSTALL_DIR: dir,
			LOCASTACK_RELEASE_BASE_URL: `${server.url.origin}`,
			LOCASTACK_RELEASE_API_URL: `${server.url.origin}/api/latest`,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, out, err };
}

describe("install.sh", () => {
	test("downloads, verifies and installs a pinned version", async () => {
		const dir = join(root, "pinned");
		requested.length = 0;
		const result = await install(dir, { VERSION: `v${GOOD}` });
		expect(result.err).toBe("");
		expect(result.exitCode).toBe(0);

		const asset = requested.find((p) => p.endsWith(".tar.gz"));
		expect(asset).toStartWith(
			`/download/v${GOOD}/locastack-${GOOD}-${hostOs}-${hostArch}`,
		);
		expect(requested).toContain(`/download/v${GOOD}/SHA256SUMS`);
		expect(requested).not.toContain("/api/latest");

		const binary = join(dir, "locastack");
		expect(statSync(binary).mode & 0o111).not.toBe(0);
		expect(result.out).toContain(`${dir} is not on your PATH`);
		expect(result.out).toContain(`>> ~/.zshrc`);
		expect(result.out.trimEnd()).toEndWith(`locastack ${GOOD}`);
	});

	test("resolves latest through the releases API and skips the PATH hint when on PATH", async () => {
		const dir = join(root, "latest");
		requested.length = 0;
		const result = await install(dir, { PATH: `${dir}:${process.env.PATH}` });
		expect(result.exitCode).toBe(0);
		expect(requested[0]).toBe("/api/latest");
		expect(result.out).toContain(`Installing LocaStack ${GOOD}`);
		expect(result.out).not.toContain("is not on your PATH");
		expect(existsSync(join(dir, "locastack"))).toBe(true);
	});

	test("refuses a download whose checksum does not match", async () => {
		const dir = join(root, "bad");
		const result = await install(dir, { VERSION: BAD });
		expect(result.exitCode).not.toBe(0);
		expect(result.err).toContain("checksum mismatch");
		expect(existsSync(join(dir, "locastack"))).toBe(false);
	});

	test("fails loudly when the release does not exist", async () => {
		const dir = join(root, "missing");
		const result = await install(dir, {
			LOCASTACK_RELEASE_BASE_URL: `${server.url.origin}/nope`,
			VERSION: GOOD,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.err).toContain("download failed");
		expect(existsSync(join(dir, "locastack"))).toBe(false);
	});
});
