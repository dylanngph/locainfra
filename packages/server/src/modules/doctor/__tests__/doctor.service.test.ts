import { describe, expect, test } from "bun:test";
import type { DoctorReport, RunDoctorDeps } from "@locainfra/core";
import {
	FakeComposeInfo,
	FakeDockerInfo,
	FakeSocketLocator,
	FixedClock,
} from "@locainfra/core/testing";
import { createDoctorRunner, DoctorService } from "../doctor.service";

const fakeDeps = (): RunDoctorDeps => ({
	docker: new FakeDockerInfo(),
	compose: new FakeComposeInfo(),
	socket: new FakeSocketLocator(),
	clock: new FixedClock("2026-09-23T08:00:00.000Z"),
});

describe("DoctorService", () => {
	test("runs core's runDoctor with the injected ports", async () => {
		const report = await new DoctorService(
			createDoctorRunner(fakeDeps()),
		).report();
		expect(report.ok).toBe(true);
		expect(report.generatedAt).toBe("2026-09-23T08:00:00.000Z");
		expect(report.checks.every((c) => c.status === "ok")).toBe(true);
	});

	test("an unreachable daemon is a failed report, not an exception", async () => {
		const deps = fakeDeps();
		const docker = new FakeDockerInfo();
		docker.error = new Error("connect ENOENT");
		const report = await new DoctorService(
			createDoctorRunner({ ...deps, docker }),
		).report();
		expect(report.ok).toBe(false);
		expect(report.checks.some((c) => c.status === "fail")).toBe(true);
	});

	test("passes its deps to the injected op", async () => {
		const deps = fakeDeps();
		const canned: DoctorReport = {
			ok: true,
			checks: [],
			generatedAt: "t",
		};
		let received: RunDoctorDeps | undefined;
		const service = new DoctorService({
			deps,
			run: async (d) => {
				received = d;
				return canned;
			},
		});
		expect(await service.report()).toBe(canned);
		expect(received).toBe(deps);
	});
});
