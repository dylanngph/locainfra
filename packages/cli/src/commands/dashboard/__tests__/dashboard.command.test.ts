import { describe, expect, test } from "bun:test";
import type { DoctorReport } from "@locastack/core";
import { createFakeDeps, createFakeIo } from "../../../__tests__/support/fakes";
import { ExitCode } from "../../../cli.types";
import { runCli } from "../../../program";

const noDocker: DoctorReport = {
	ok: false,
	generatedAt: "2026-09-24T00:00:00.000Z",
	checks: [
		{
			id: "docker.socket",
			label: "Docker socket",
			status: "fail",
			detail: "No Docker socket found",
			fix: "Start Docker Desktop and run `locastack doctor` again.",
		},
		{ id: "compose.present", label: "Docker Compose", status: "ok" },
	],
};

describe("bare locastack without Docker", () => {
	test("prints the failing checks and exits 1 without starting the dashboard", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps({ report: noDocker });
		const code = await runCli(["--no-open"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(calls.doctor).toBe(1);
		expect(calls.dashboard).toEqual([]);
		const text = Bun.stripANSI(io.out.text + io.err.text);
		expect(text).toContain("Start Docker Desktop");
		expect(text).toContain("run `locastack` again");
	});

	test("--json reports ok:false with the doctor report and exits 1", async () => {
		const io = createFakeIo();
		const { loadDeps, calls } = createFakeDeps({ report: noDocker });
		const code = await runCli(["--no-open", "--json"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(calls.dashboard).toEqual([]);
		const parsed = JSON.parse(
			io.out.text.trim().split("\n").at(-1) ?? "{}",
		) as {
			ok: boolean;
			doctor: { ok: boolean };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.doctor.ok).toBe(false);
	});
});
