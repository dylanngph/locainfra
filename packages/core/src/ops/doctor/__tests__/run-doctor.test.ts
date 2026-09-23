import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
	FakeComposeInfo,
	FakeDockerInfo,
	FakeSocketLocator,
	FixedClock,
} from "../../../testing/fakes";
import { DoctorReport } from "../doctor.model";
import { DOCTOR_CHECK_IDS, runDoctor } from "../run-doctor.op";

function deps() {
	return {
		docker: new FakeDockerInfo(),
		compose: new FakeComposeInfo("5.3.0"),
		socket: new FakeSocketLocator(),
		clock: new FixedClock("2026-09-23T12:00:00.000Z"),
	};
}

function statusOf(report: DoctorReport, id: string) {
	return report.checks.find((check) => check.id === id)?.status;
}

describe("runDoctor", () => {
	test("healthy setup: every check ok and schema-valid report", async () => {
		const report = await runDoctor(deps());
		expect(report.ok).toBe(true);
		expect(report.generatedAt).toBe("2026-09-23T12:00:00.000Z");
		expect(report.checks.map((c) => [c.id, c.status])).toEqual([
			[DOCTOR_CHECK_IDS.socket, "ok"],
			[DOCTOR_CHECK_IDS.reachable, "ok"],
			[DOCTOR_CHECK_IDS.api, "ok"],
			[DOCTOR_CHECK_IDS.composeInstalled, "ok"],
			[DOCTOR_CHECK_IDS.composeVersion, "ok"],
		]);
		expect(Value.Check(DoctorReport, report)).toBe(true);
	});

	test("socket missing fails with a fix", async () => {
		const d = deps();
		d.socket.path = null;
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		const check = report.checks.find((c) => c.id === DOCTOR_CHECK_IDS.socket);
		expect(check?.status).toBe("fail");
		expect(check?.fix).toContain("DOCKER_HOST");
	});

	test("daemon unreachable fails and skips the API check", async () => {
		const d = deps();
		d.docker.error = new Error("connect ECONNREFUSED");
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK_IDS.reachable)).toBe("fail");
		expect(statusOf(report, DOCTOR_CHECK_IDS.api)).toBeUndefined();
		expect(
			report.checks.find((c) => c.id === DOCTOR_CHECK_IDS.reachable)?.fix,
		).toContain("Start Docker");
	});

	test("API older than 1.44 fails", async () => {
		const d = deps();
		d.docker.value = { ...d.docker.value, apiVersion: "1.43" };
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK_IDS.api)).toBe("fail");
	});

	test("API exactly 1.44 passes", async () => {
		const d = deps();
		d.docker.value = { ...d.docker.value, apiVersion: "1.44" };
		expect(statusOf(await runDoctor(d), DOCTOR_CHECK_IDS.api)).toBe("ok");
	});

	test("compose missing fails and skips the version check", async () => {
		const d = deps();
		d.compose.current = null;
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK_IDS.composeInstalled)).toBe("fail");
		expect(statusOf(report, DOCTOR_CHECK_IDS.composeVersion)).toBeUndefined();
	});

	test("compose older than 2.24 fails", async () => {
		const d = deps();
		d.compose.current = "2.23.3";
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK_IDS.composeVersion)).toBe("fail");
	});

	test("compose between 2.24 and 2.30 warns but stays ok", async () => {
		const d = deps();
		d.compose.current = "v2.29.1-desktop.1";
		const report = await runDoctor(d);
		expect(report.ok).toBe(true);
		expect(statusOf(report, DOCTOR_CHECK_IDS.composeVersion)).toBe("warn");
	});

	test("unparsable versions warn", async () => {
		const d = deps();
		d.compose.current = "dev";
		d.docker.value = { ...d.docker.value, apiVersion: "unknown" };
		const report = await runDoctor(d);
		expect(report.ok).toBe(true);
		expect(statusOf(report, DOCTOR_CHECK_IDS.composeVersion)).toBe("warn");
		expect(statusOf(report, DOCTOR_CHECK_IDS.api)).toBe("warn");
	});

	test("never throws when ports throw", async () => {
		const d = deps();
		d.socket.locate = async () => {
			throw new Error("context broken");
		};
		d.compose.version = async () => {
			throw new Error("spawn ENOENT");
		};
		const report = await runDoctor(d);
		expect(report.ok).toBe(false);
		expect(statusOf(report, DOCTOR_CHECK_IDS.socket)).toBe("fail");
		expect(statusOf(report, DOCTOR_CHECK_IDS.composeInstalled)).toBe("fail");
	});
});
