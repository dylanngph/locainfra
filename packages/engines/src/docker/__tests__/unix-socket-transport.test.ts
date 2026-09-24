import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOpError } from "@locastack/core";
import { negotiateApiVersion } from "../api-version";
import type { DockerTransport } from "../transport";
import { UnixSocketTransport } from "../unix-socket-transport";
import { FakeTransport } from "./fake-transport";

describe("negotiateApiVersion", () => {
	test("uses the daemon version when it is older", () => {
		expect(negotiateApiVersion("1.44", "1.41")).toBe("1.41");
	});
	test("keeps the preferred version when the daemon is newer", () => {
		expect(negotiateApiVersion("1.44", "1.55")).toBe("1.44");
	});
	test("ignores malformed daemon versions", () => {
		expect(negotiateApiVersion("1.44", "garbage")).toBe("1.44");
		expect(negotiateApiVersion("1.44", undefined)).toBe("1.44");
	});
});

/** A fake Docker daemon served on a real unix socket. */
function startFakeDaemon(socket: string, apiVersion: string) {
	const seen: string[] = [];
	const server = Bun.serve({
		unix: socket,
		fetch(request) {
			const { pathname } = new URL(request.url);
			seen.push(pathname);
			if (pathname === "/version" || pathname.endsWith("/version")) {
				return Response.json({
					Version: "29.0.0",
					ApiVersion: apiVersion,
					Os: "linux",
					Arch: "arm64",
				});
			}
			if (pathname.endsWith("/containers/json")) return Response.json([]);
			return Response.json({ message: "page not found" }, { status: 404 });
		},
	});
	return { server, seen };
}

describe("UnixSocketTransport over a real unix socket", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ls-transport-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prefixes paths with the preferred version when the daemon is newer", async () => {
		const socket = join(dir, "new.sock");
		const { server, seen } = startFakeDaemon(socket, "1.55");
		try {
			const transport = new UnixSocketTransport({ socketPath: socket });
			const response = await transport.request("/containers/json?all=1");
			expect(response.status).toBe(200);
			expect(await transport.apiVersion()).toBe("1.44");
			expect(seen).toEqual(["/version", "/v1.44/containers/json"]);
		} finally {
			server.stop(true);
		}
	});

	test("downgrades to an older daemon's API version", async () => {
		const socket = join(dir, "old.sock");
		const { server, seen } = startFakeDaemon(socket, "1.41");
		try {
			const transport = new UnixSocketTransport({ socketPath: socket });
			await transport.request("/containers/json");
			await transport.request("/version");
			expect(seen).toEqual([
				"/version",
				"/v1.41/containers/json",
				"/v1.41/version",
			]);
		} finally {
			server.stop(true);
		}
	});

	test("a missing socket rejects with DOCKER_UNREACHABLE", async () => {
		const transport = new UnixSocketTransport({
			socketPath: join(dir, "missing.sock"),
		});
		const error = await transport.request("/version").catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("DOCKER_UNREACHABLE");
	});

	test("a locator returning null rejects with DOCKER_UNREACHABLE", async () => {
		const transport = new UnixSocketTransport({
			locator: { locate: async () => null },
		});
		const error = await transport.request("/version").catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("DOCKER_UNREACHABLE");
	});
});

describe("DockerTransport contract", () => {
	let dir: string;
	let stop: () => void = () => {};
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ls-contract-"));
		const { server } = startFakeDaemon(join(dir, "d.sock"), "1.44");
		stop = () => server.stop(true);
	});
	afterAll(() => {
		stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const implementations: ReadonlyArray<
		readonly [string, () => DockerTransport]
	> = [
		[
			"UnixSocketTransport",
			() => new UnixSocketTransport({ socketPath: join(dir, "d.sock") }),
		],
		[
			"FakeTransport",
			() =>
				new FakeTransport([
					[
						"/version",
						() => Response.json({ Version: "29.0.0", ApiVersion: "1.44" }),
					],
					["/containers/json", () => Response.json([])],
				]),
		],
	];

	describe.each(implementations)("%s", (_name, make) => {
		test("resolves 2xx JSON responses", async () => {
			const response = await make().request("/containers/json?all=1");
			expect(response.ok).toBe(true);
			expect(await response.json()).toEqual([]);
		});
		test("resolves (does not reject) non-2xx responses", async () => {
			const response = await make().request("/nope");
			expect(response.status).toBe(404);
		});
	});
});
