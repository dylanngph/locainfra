import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { DoctorReport } from "../../ops/doctor/doctor.model";
import { SetupPlan } from "../../ops/ops.model";
import { PlatformFacts, PlatformSummary } from "../../ports/platform.port";
import type { CommandStep } from "../../ports/process.port";
import {
	createLinuxPlatformFacts,
	createPlatformFacts,
	FakeDaemonWaiter,
	FakePlatformInspector,
	FakeProcessRunner,
} from "../setup-fakes";

const step = (id: string): CommandStep => ({
	id,
	title: id,
	argv: ["colima", "start"],
});

describe("setup fakes", () => {
	test("default facts are schema-valid for both platforms", () => {
		expect(Value.Check(PlatformFacts, createPlatformFacts())).toBe(true);
		expect(Value.Check(PlatformFacts, createLinuxPlatformFacts())).toBe(true);
		expect(
			Value.Check(PlatformSummary, {
				os: "darwin",
				arch: "arm64",
				hasBrew: true,
				hasSystemd: false,
				installedRuntimes: ["colima"],
				runningRuntime: "colima",
			}),
		).toBe(true);
	});

	test("FakePlatformInspector returns copies, counts calls, can reject", async () => {
		const inspector = new FakePlatformInspector(
			createPlatformFacts({ installedRuntimes: ["orbstack"] }),
		);
		const facts = await inspector.inspect();
		facts.installedRuntimes.push("colima");
		expect(inspector.facts.installedRuntimes).toEqual(["orbstack"]);
		inspector.error = new Error("boom");
		await expect(inspector.inspect()).rejects.toThrow("boom");
		expect(inspector.calls).toBe(2);
	});

	test("FakeProcessRunner records calls and replays scripts", async () => {
		const runner = new FakeProcessRunner()
			.on("fails", { exitCode: 3, output: "nope" })
			.on("throws", new Error("spawn"));
		expect(await runner.run(step("ok"), { attached: true })).toEqual({
			exitCode: 0,
			timedOut: false,
		});
		expect(await runner.run(step("fails"), { attached: false })).toEqual({
			exitCode: 3,
			timedOut: false,
			output: "nope",
		});
		await expect(
			runner.run(step("throws"), { attached: true }),
		).rejects.toThrow("spawn");
		expect(runner.ranIds()).toEqual(["ok", "fails", "throws"]);
	});

	test("FakeDaemonWaiter consumes its sequence then answers ready", async () => {
		const waiter = new FakeDaemonWaiter(true);
		waiter.sequence.push(false);
		expect(await waiter.waitForDocker(10)).toBe(false);
		expect(await waiter.waitForDocker(20)).toBe(true);
		expect(waiter.calls).toEqual([10, 20]);
		const aborted = AbortSignal.abort();
		expect(await waiter.waitForDocker(30, aborted)).toBe(false);
	});
});

describe("setup models", () => {
	test("a pre-0.2 doctor report (no platform/setupNeeded) still validates", () => {
		expect(
			Value.Check(DoctorReport, {
				ok: true,
				checks: [{ id: "docker.reachable", label: "Docker", status: "ok" }],
				generatedAt: "2026-09-24T00:00:00.000Z",
			}),
		).toBe(true);
	});

	test("a colima install plan validates; argv must not be empty", () => {
		const plan: SetupPlan = {
			kind: "install",
			provider: "colima",
			alternatives: ["docker-desktop", "orbstack"],
			reason: "Docker is not installed; install Colima with Homebrew.",
			steps: [
				{
					id: "brew.install",
					title: "Installing Colima, the Docker CLI and Compose",
					argv: [
						"/opt/homebrew/bin/brew",
						"install",
						"colima",
						"docker",
						"docker-compose",
					],
				},
				{
					id: "colima.start",
					title: "Starting Colima",
					argv: ["colima", "start"],
				},
			],
			postNotes: [],
			needsTerminal: false,
		};
		expect(Value.Check(SetupPlan, plan)).toBe(true);
		expect(
			Value.Check(SetupPlan, {
				...plan,
				steps: [{ id: "x", title: "x", argv: [] }],
			}),
		).toBe(false);
	});
});
