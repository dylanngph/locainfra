import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dashboardUrl,
	probeDashboard,
	readDashboardFile,
	removeDashboardFile,
	writeDashboardFile,
} from "../dashboard-file";

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "locastack-dash-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const info = {
	pid: 4242,
	port: 4488,
	token: "tok en",
	startedAt: "2026-09-23T08:00:00.000Z",
};

describe("dashboard file", () => {
	it("round-trips and rejects garbage", async () => {
		const path = join(dir, "a", "dashboard.json");
		await writeDashboardFile(path, info);
		expect(await readDashboardFile(path)).toEqual(info);
		await writeFile(path, "{not json");
		expect(await readDashboardFile(path)).toBeNull();
		await writeFile(path, JSON.stringify({ ...info, port: "x" }));
		expect(await readDashboardFile(path)).toBeNull();
		expect(await readDashboardFile(join(dir, "missing.json"))).toBeNull();
	});

	it("only removes the file of the given pid", async () => {
		const path = join(dir, "b.json");
		await writeDashboardFile(path, info);
		await removeDashboardFile(path, 1);
		expect(await readDashboardFile(path)).not.toBeNull();
		await removeDashboardFile(path, info.pid);
		expect(await readDashboardFile(path)).toBeNull();
	});

	it("probes pid liveness and /api/health", async () => {
		const path = join(dir, "c.json");
		await writeDashboardFile(path, info);
		const healthy = async () => Response.json({ ok: true });
		expect(
			await probeDashboard(path, { isAlive: () => true, fetch: healthy }),
		).toEqual({ ...info, url: "http://127.0.0.1:4488/?t=tok%20en" });
		expect(
			await probeDashboard(path, { isAlive: () => false, fetch: healthy }),
		).toBeNull();
		expect(
			await probeDashboard(path, {
				isAlive: () => true,
				fetch: async () => new Response("nope", { status: 500 }),
			}),
		).toBeNull();
		expect(
			await probeDashboard(path, {
				isAlive: () => true,
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		).toBeNull();
		expect(dashboardUrl(1, "a&b")).toBe("http://127.0.0.1:1/?t=a%26b");
	});
});
