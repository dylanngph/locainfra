import { describe, expect, it } from "bun:test";
import { DOCTOR_CHECK_IDS } from "@locainfra/core";
import { createApp } from "../app";
import { createTestDeps, HOST } from "./support/fixtures";

const app = createApp(createTestDeps());

const req = (path: string, headers: Record<string, string> = {}) =>
	app.handle(
		new Request(`http://${HOST}${path}`, {
			headers: { host: HOST, ...headers },
		}),
	);

describe("app", () => {
	it("health is public", async () => {
		const res = await req("/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
	it("rejects doctor without token", async () => {
		expect((await req("/api/doctor")).status).toBe(401);
	});
	it("rejects foreign host (DNS rebinding)", async () => {
		const res = await app.handle(
			new Request("http://evil.test/api/doctor?t=secret", {
				headers: { host: "evil.test" },
			}),
		);
		expect(res.status).toBe(403);
	});
	it("rejects a foreign origin", async () => {
		const res = await req("/api/doctor?t=secret", {
			origin: "http://evil.test",
		});
		expect(res.status).toBe(403);
	});
	it("returns a report with a valid token", async () => {
		const res = await req("/api/doctor?t=secret");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			checks: { id: string }[];
		};
		expect(body.ok).toBe(true);
		expect(body.checks.map((c) => c.id)).toEqual(
			Object.values(DOCTOR_CHECK_IDS),
		);
	});
	it("does not serve an SPA without staticDir", async () => {
		expect((await req("/")).status).toBe(404);
		expect((await req("/p/shop-api")).status).toBe(404);
	});
});
