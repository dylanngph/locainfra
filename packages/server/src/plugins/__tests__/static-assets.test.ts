import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { staticAssets } from "../static-assets";

const HOST = "127.0.0.1:4488";
let dir: string;
let app: { handle(request: Request): Promise<Response> };

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "locastack-static-"));
	await mkdir(join(dir, "dist", "assets"), { recursive: true });
	await writeFile(join(dir, "dist", "index.html"), "INDEX");
	await writeFile(join(dir, "dist", "favicon.svg"), "<svg/>");
	await writeFile(join(dir, "dist", "assets", "app-abc.js"), "APP");
	await writeFile(join(dir, "secret.txt"), "SECRET");
	app = new Elysia()
		.get("/api/health", () => ({ ok: true }))
		.use(staticAssets({ dir: join(dir, "dist"), allowedHosts: [HOST] }));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const get = (path: string, host = HOST) =>
	app.handle(new Request(`http://${host}${path}`, { headers: { host } }));

describe("staticAssets", () => {
	it("serves files and falls back to index.html for client routes", async () => {
		expect(await (await get("/")).text()).toBe("INDEX");
		expect(await (await get("/p/shop/env?fmt=json")).text()).toBe("INDEX");
		const icon = await get("/favicon.svg");
		expect(await icon.text()).toBe("<svg/>");
		expect(icon.headers.get("content-type")).toContain("svg");
	});

	it("keeps API routes and unknown API paths out of the fallback", async () => {
		expect(await (await get("/api/health")).json()).toEqual({ ok: true });
		expect((await get("/api/unknown")).status).toBe(404);
		expect((await get("/api")).status).toBe(404);
	});

	it("caches hashed /assets/* forever and everything else never", async () => {
		const asset = await get("/assets/app-abc.js");
		expect(await asset.text()).toBe("APP");
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect((await get("/")).headers.get("cache-control")).toBe("no-cache");
		expect((await get("/p/shop")).headers.get("cache-control")).toBe(
			"no-cache",
		);
	});

	it("404s missing files that have an extension instead of falling back", async () => {
		expect((await get("/assets/missing.js")).status).toBe(404);
	});

	it("never serves files outside the folder", async () => {
		const res = await get("/%2e%2e/secret.txt");
		expect(await res.text()).not.toBe("SECRET");
		expect((await get("/%2e%2e/secret.txt")).status).toBe(404);
		expect((await get("/assets/%2e%2e/%2e%2e/secret.txt")).status).toBe(404);
		expect((await get("/%E0%A4%A")).status).toBe(404);
	});

	it("checks the Host header", async () => {
		expect((await get("/", "evil.test")).status).toBe(403);
	});
});
