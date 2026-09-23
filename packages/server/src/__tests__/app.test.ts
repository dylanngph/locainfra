import { describe, expect, it } from "bun:test";
import { DOCTOR_CHECK_IDS } from "@locainfra/core";
import {
	FakeComposeInfo,
	FakeDockerInfo,
	FakeSocketLocator,
	FixedClock,
} from "@locainfra/core/testing";
import { createApp } from "../app";
import { createDoctorRunner } from "../modules/doctor/doctor.service";

const HOST = "127.0.0.1:4488";
const app = createApp({
	token: "secret",
	allowedHosts: [HOST],
	doctor: createDoctorRunner({
		docker: new FakeDockerInfo(),
		compose: new FakeComposeInfo(),
		socket: new FakeSocketLocator(),
		clock: new FixedClock(),
	}),
});

const req = (path: string, headers: Record<string, string> = {}) =>
	app.handle(
		new Request(`http://${HOST}${path}`, {
			headers: { host: HOST, ...headers },
		}),
	);

describe("app", () => {
	it("health is public", async () => {
		expect((await req("/api/health")).status).toBe(200);
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
});
