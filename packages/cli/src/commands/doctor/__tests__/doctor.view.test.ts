import { describe, expect, test } from "bun:test";
import { sampleReport } from "../../../__tests__/support/fakes";
import {
	countDoctorChecks,
	formatDoctorReport,
	formatDoctorSummary,
} from "../doctor.view";

describe("doctor view", () => {
	test("counts statuses", () => {
		expect(countDoctorChecks(sampleReport)).toEqual({
			ok: 1,
			warn: 1,
			fail: 0,
		});
	});

	test("summary line", () => {
		expect(Bun.stripANSI(formatDoctorSummary(sampleReport))).toBe(
			"▲ Doctor: 1 ok · 1 warn · 0 fail",
		);
	});

	test("report aligns rows and shows fixes only for non-ok checks", () => {
		const lines = Bun.stripANSI(formatDoctorReport(sampleReport)).split("\n");
		expect(lines[0]).toBe("  ✓  Docker reachable  Engine 29.6.1");
		expect(lines[1]).toBe("  ▲  Compose version   2.25.0");
		expect(lines[2]).toContain("fix: Update Docker Desktop");
		expect(lines.at(-1)).toBe("▲ Doctor: 1 ok · 1 warn · 0 fail");
	});
});
