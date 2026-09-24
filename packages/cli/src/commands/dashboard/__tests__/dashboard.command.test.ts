import { describe, expect, test } from "bun:test";
import type { DoctorReport } from "@locastack/core";
import {
	createFakeDeps,
	createFakeIo,
	linuxInstallPlan,
	linuxStartPlan,
	macColimaInstallPlan,
	sampleReport,
	stoppedDockerReport,
} from "../../../__tests__/support/fakes";
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
		const text = Bun.stripANSI(io.out.text + io.errOut.text);
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

describe("bare locastack offers Docker setup in a terminal", () => {
	test("starts a stopped runtime on yes, then opens the dashboard", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls, runner } = createFakeDeps({
			reports: [stoppedDockerReport, sampleReport],
			plan: linuxStartPlan,
		});
		const code = await runCli(["--no-open"], loadDeps, io);
		expect(code).toBe(ExitCode.Ok);
		expect(io.questions).toEqual([
			"Docker is not running. Start Docker Engine now? (runs the 1 command above)",
		]);
		expect(calls.planSetup).toEqual([{ report: stoppedDockerReport }]);
		expect(runner.ranIds()).toEqual(["docker.start"]);
		expect(calls.doctor).toBe(2);
		expect(calls.dashboard).toEqual([
			"find",
			"port:4488",
			"start:4489",
			"wait",
			"stop",
		]);
		const out = Bun.stripANSI(io.out.text);
		expect(out).toContain("$ sudo systemctl start docker");
		expect(out).toContain("Dashboard: http://127.0.0.1:4489/?t=tok");
	});

	test("install offer lists the commands before asking; Not now declines", async () => {
		let shownFirst = "";
		const io = createFakeIo({
			isTTY: true,
			answer: (q) => {
				shownFirst ||= Bun.stripANSI(io.out.text);
				return q.startsWith("Set up Docker") ? "decline" : undefined;
			},
		});
		const { loadDeps, calls, runner } = createFakeDeps({
			report: noDocker,
			plan: macColimaInstallPlan,
		});
		const code = await runCli(["--no-open"], loadDeps, io);
		expect(code).toBe(ExitCode.OpError);
		expect(io.questions).toEqual([
			"Set up Docker with Colima? (the 4 commands above, or pick another runtime)",
		]);
		expect(shownFirst).toContain(
			"$ /opt/homebrew/bin/brew install colima docker docker-compose",
		);
		expect(runner.calls).toEqual([]);
		expect(calls.dashboard).toEqual([]);
	});

	test("declining ends with one instruction, not two", async () => {
		const io = createFakeIo({ isTTY: true, confirm: false });
		const { loadDeps, calls, runner } = createFakeDeps({
			report: stoppedDockerReport,
			plan: linuxStartPlan,
		});
		expect(await runCli(["--no-open"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(runner.calls).toEqual([]);
		expect(calls.dashboard).toEqual([]);
		const err = Bun.stripANSI(io.errOut.text);
		expect(err).toContain(
			"Nothing else was run. Run `locastack setup` when you are ready.",
		);
		expect(err).not.toContain("Fix the failing checks above");
	});

	test("a docker-group change tells the user to log in again, not to fix checks", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls } = createFakeDeps({
			report: noDocker,
			plan: linuxInstallPlan,
		});
		expect(await runCli(["--no-open"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(calls.dashboard).toEqual([]);
		const err = Bun.stripANSI(io.errOut.text);
		expect(err).toContain(
			"Log out and back in (or run `newgrp docker`), then run `locastack`.",
		);
		expect(err).not.toContain("Fix the failing checks above");
	});

	test("a setup that still fails prints the checks that still fail", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps } = createFakeDeps({
			reports: [stoppedDockerReport, noDocker],
			plan: linuxStartPlan,
		});
		expect(await runCli(["--no-open"], loadDeps, io)).toBe(ExitCode.OpError);
		const out = Bun.stripANSI(io.out.text);
		// The checks of the report taken after the run, not the first one.
		const after = out.slice(out.lastIndexOf("Doctor:"));
		expect(after).toContain(
			"Docker socket: Start Docker Desktop and run `locastack doctor` again.",
		);
		const all = Bun.stripANSI(io.out.text + io.errOut.text);
		expect(all).toContain(
			"Setup did not make Docker usable: fix the checks above, then run `locastack` again.",
		);
	});

	test("a failed start keeps the exit-1 behaviour", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls, runner } = createFakeDeps({
			report: stoppedDockerReport,
			plan: linuxStartPlan,
		});
		runner.on("docker.start", { exitCode: 1 });
		expect(await runCli(["--no-open"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(calls.dashboard).toEqual([]);
	});

	test("never offers without a terminal or with --json", async () => {
		for (const [args, isTTY] of [
			[["--no-open"], false],
			[["--no-open", "--json"], true],
		] as const) {
			const io = createFakeIo({ isTTY, confirm: true });
			const { loadDeps, calls } = createFakeDeps({
				report: stoppedDockerReport,
				plan: linuxStartPlan,
			});
			expect(await runCli([...args], loadDeps, io)).toBe(ExitCode.OpError);
			expect(io.questions).toEqual([]);
			expect(calls.planSetup).toEqual([]);
		}
	});
});
