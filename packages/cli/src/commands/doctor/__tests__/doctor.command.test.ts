import { describe, expect, test } from "bun:test";
import {
	createFakeDeps,
	createFakeIo,
	linuxStartPlan,
	sampleReport,
	stoppedDockerReport,
} from "../../../__tests__/support/fakes";
import { ExitCode } from "../../../cli.types";
import { runCli } from "../../../program";

describe("locastack doctor offers Docker setup", () => {
	test("in a terminal, a yes runs the plan and exits 0 once Docker works", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, runner } = createFakeDeps({
			reports: [stoppedDockerReport, sampleReport],
			plan: linuxStartPlan,
		});
		expect(await runCli(["doctor"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(io.questions).toHaveLength(1);
		expect(runner.ranIds()).toEqual(["docker.start"]);
	});

	test("a no runs nothing and exits 1", async () => {
		const io = createFakeIo({ isTTY: true, confirm: false });
		const { loadDeps, runner } = createFakeDeps({
			report: stoppedDockerReport,
			plan: linuxStartPlan,
		});
		expect(await runCli(["doctor"], loadDeps, io)).toBe(ExitCode.OpError);
		expect(io.questions).toHaveLength(1);
		expect(runner.calls).toEqual([]);
	});

	test("--json and non-TTY never offer", async () => {
		for (const [args, isTTY] of [
			[["doctor", "--json"], true],
			[["doctor"], false],
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

	test("a passing report offers nothing", async () => {
		const io = createFakeIo({ isTTY: true, confirm: true });
		const { loadDeps, calls } = createFakeDeps();
		expect(await runCli(["doctor"], loadDeps, io)).toBe(ExitCode.Ok);
		expect(calls.planSetup).toEqual([]);
	});
});
