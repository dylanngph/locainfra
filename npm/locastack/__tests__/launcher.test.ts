import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = join(import.meta.dir, "..");
/** Input of the launcher's `selectBinary`. */
interface Host {
	platform: string;
	arch: string;
	musl: boolean;
	translated: () => boolean;
	resolve: (request: string) => string;
}

/** Result of the launcher's `selectBinary`. */
type Selection =
	| { kind: "unsupported" }
	| { kind: "missing"; target: string }
	| { kind: "found"; target: string; binary: string; warning?: string };

const launcher: {
	targetFor(platform: string, arch: string, musl: boolean): string | null;
	isMusl(): boolean;
	isRosettaTranslated(
		exec: (file: string, args: string[], options: object) => string,
	): boolean;
	selectBinary(host: Host): Selection;
	ROSETTA_WARNING: string;
} = createRequire(import.meta.url)("../bin/locastack.js");

const TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
];

/** Fake platform binary: echoes its target and args, then exits/kills on request. */
const fakeBinary = (target: string) => `#!/bin/sh
echo "target=${target} args=$*"
case "$1" in
  exit) exit "$2" ;;
  kill) kill -TERM $$ ;;
  stderr) echo "to-stderr" >&2 ;;
esac
`;

/** Copies the launcher package into `<root>/node_modules/locastack`. */
function installLauncher(root: string): string {
	const dest = join(root, "node_modules", "locastack");
	mkdirSync(join(dest, "bin"), { recursive: true });
	cpSync(join(pkgDir, "package.json"), join(dest, "package.json"));
	cpSync(
		join(pkgDir, "bin", "locastack.js"),
		join(dest, "bin", "locastack.js"),
	);
	return join(dest, "bin", "locastack.js");
}

const runtime = Bun.which("node") ?? process.execPath;
const run = (script: string, args: string[]) =>
	Bun.spawnSync([runtime, script, ...args], { stdout: "pipe", stderr: "pipe" });

let withPackages: string;
let withoutPackages: string;

beforeAll(() => {
	withPackages = mkdtempSync(join(tmpdir(), "locastack-npm-"));
	for (const target of TARGETS) {
		const dir = join(
			withPackages,
			"node_modules",
			"@locastack",
			`cli-${target}`,
		);
		mkdirSync(join(dir, "bin"), { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: `@locastack/cli-${target}`, version: "0.1.0" }),
		);
		writeFileSync(join(dir, "bin", "locastack"), fakeBinary(target));
		// Package managers can drop the executable bit; the launcher must restore it.
		chmodSync(join(dir, "bin", "locastack"), 0o644);
	}
	installLauncher(withPackages);
	withoutPackages = mkdtempSync(join(tmpdir(), "locastack-npm-empty-"));
	installLauncher(withoutPackages);
});

afterAll(() => {
	rmSync(withPackages, { recursive: true, force: true });
	rmSync(withoutPackages, { recursive: true, force: true });
});

describe("manifest", () => {
	test("pins one optional platform package per target at the launcher version", async () => {
		const manifest = await Bun.file(join(pkgDir, "package.json")).json();
		const expected = Object.fromEntries(
			TARGETS.map((target) => [`@locastack/cli-${target}`, manifest.version]),
		);
		expect(manifest.optionalDependencies).toEqual(expected);
		expect(manifest.bin).toEqual({ locastack: "bin/locastack.js" });
	});
});

describe("targetFor", () => {
	test("maps supported platforms", () => {
		expect(launcher.targetFor("darwin", "arm64", false)).toBe("darwin-arm64");
		expect(launcher.targetFor("darwin", "x64", false)).toBe("darwin-x64");
		expect(launcher.targetFor("linux", "x64", false)).toBe("linux-x64");
		expect(launcher.targetFor("linux", "arm64", true)).toBe("linux-arm64-musl");
	});

	test("never picks musl on macOS", () => {
		expect(launcher.targetFor("darwin", "arm64", true)).toBe("darwin-arm64");
	});

	test("rejects Windows and other architectures", () => {
		expect(launcher.targetFor("win32", "x64", false)).toBeNull();
		expect(launcher.targetFor("linux", "ia32", false)).toBeNull();
		expect(launcher.targetFor("freebsd", "x64", false)).toBeNull();
	});

	test("isMusl is false off Linux", () => {
		if (process.platform !== "linux") expect(launcher.isMusl()).toBe(false);
	});
});

describe("Rosetta", () => {
	/** A fake `require.resolve` that knows only the given platform packages. */
	const resolver =
		(...targets: string[]) =>
		(request: string): string => {
			const target = targets.find((t) =>
				request.startsWith(`@locastack/cli-${t}/`),
			);
			if (target === undefined) throw new Error(`Cannot find ${request}`);
			return `/nm/@locastack/cli-${target}/bin/locastack`;
		};
	const intelNode = (translated: boolean, ...installed: string[]): Host => ({
		platform: "darwin",
		arch: "x64",
		musl: false,
		translated: () => translated,
		resolve: resolver(...installed),
	});

	test("an Intel Node under Rosetta prefers the arm64 package when it resolves", () => {
		expect(
			launcher.selectBinary(intelNode(true, "darwin-x64", "darwin-arm64")),
		).toEqual({
			kind: "found",
			target: "darwin-arm64",
			binary: "/nm/@locastack/cli-darwin-arm64/bin/locastack",
		});
	});

	test("without the arm64 package it runs the x64 binary with one warning line", () => {
		const selected = launcher.selectBinary(intelNode(true, "darwin-x64"));
		expect(selected).toEqual({
			kind: "found",
			target: "darwin-x64",
			binary: "/nm/@locastack/cli-darwin-x64/bin/locastack",
			warning:
				"locastack: running the Intel build under Rosetta because Node is Intel; install an Apple Silicon Node for a native binary.",
		});
		expect(launcher.ROSETTA_WARNING).not.toContain("\n");
	});

	test("a real Intel Mac and native hosts never ask or warn", () => {
		let asked = 0;
		const count = () => {
			asked += 1;
			return false;
		};
		expect(
			launcher.selectBinary({
				...intelNode(false, "darwin-x64", "darwin-arm64"),
				translated: count,
			}),
		).toEqual({
			kind: "found",
			target: "darwin-x64",
			binary: "/nm/@locastack/cli-darwin-x64/bin/locastack",
		});
		expect(asked).toBe(1);
		const native = launcher.selectBinary({
			platform: "darwin",
			arch: "arm64",
			musl: false,
			translated: () => {
				throw new Error("must not be called");
			},
			resolve: resolver("darwin-arm64"),
		});
		expect(native.kind).toBe("found");
		expect(launcher.selectBinary(intelNode(true)).kind).toBe("missing");
		expect(
			launcher.selectBinary({ ...intelNode(false), platform: "win32" }).kind,
		).toBe("unsupported");
	});

	test("isRosettaTranslated reads sysctl.proc_translated", () => {
		const calls: string[][] = [];
		const answer = (value: string) => (file: string, args: string[]) => {
			calls.push([file, ...args]);
			return value;
		};
		expect(launcher.isRosettaTranslated(answer("1\n"))).toBe(true);
		expect(launcher.isRosettaTranslated(answer("0\n"))).toBe(false);
		expect(
			launcher.isRosettaTranslated(() => {
				throw new Error("unknown oid");
			}),
		).toBe(false);
		expect(calls[0]).toEqual(["sysctl", "-n", "sysctl.proc_translated"]);
	});
});

describe("launcher", () => {
	const script = () =>
		join(withPackages, "node_modules", "locastack", "bin", "locastack.js");
	// Ask the same runtime that runs the launcher, so libc detection matches.
	const hostTarget = Bun.spawnSync([
		runtime,
		"-p",
		"const l = require(process.argv[1]); l.targetFor(process.platform, process.arch, l.isMusl())",
		join(pkgDir, "bin", "locastack.js"),
	])
		.stdout.toString()
		.trim();

	test("runs the matching platform binary with forwarded args", () => {
		const result = run(script(), ["up", "--json", "a b"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe(
			`target=${hostTarget} args=up --json a b\n`,
		);
	});

	test("forwards the exit code", () => {
		expect(run(script(), ["exit", "7"]).exitCode).toBe(7);
	});

	test("passes stderr through", () => {
		expect(run(script(), ["stderr"]).stderr.toString()).toBe("to-stderr\n");
	});

	test("re-raises the child's terminating signal", () => {
		const result = run(script(), ["kill"]);
		expect(result.signalCode).toBe("SIGTERM");
	});

	test("points at the curl installer when the platform package is missing", () => {
		const result = run(
			join(withoutPackages, "node_modules", "locastack", "bin", "locastack.js"),
			["--version"],
		);
		expect(result.exitCode).toBe(1);
		const stderr = result.stderr.toString();
		expect(stderr).toContain(`@locastack/cli-${hostTarget}`);
		expect(stderr).toContain("install.sh | sh");
	});
});
