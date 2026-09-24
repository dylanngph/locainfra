import { describe, expect, test } from "bun:test";
import { collect } from "../../../testing/collect";
import {
	createLinuxPlatformFacts,
	createPlatformFacts,
} from "../../../testing/setup-fakes";
import { DOCTOR_CHECK } from "../../doctor/doctor.model";
import { planSetup } from "../plan-setup.op";
import { SETUP_STEP } from "../setup-steps";
import { startDockerRuntime } from "../start-docker-runtime.op";
import { reportWith, setupWorld } from "./setup-world";

describe("planSetup", () => {
	test("inspects, runs doctor and plans", async () => {
		const w = setupWorld(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
		);
		w.down();
		const plan = await planSetup(w.deps, {});
		expect(plan.kind).toBe("start");
		expect(plan.provider).toBe("colima");
		// once for the planner, once inside doctor
		expect(w.platform.calls).toBe(2);
	});

	test("reuses a given report and passes the options", async () => {
		const w = setupWorld(createPlatformFacts());
		w.down();
		const none = await planSetup(w.deps, { report: reportWith([]) });
		expect(none.kind).toBe("none");
		expect(w.platform.calls).toBe(1);
		const orb = await planSetup(w.deps, {
			report: reportWith([DOCTOR_CHECK.daemon]),
			runtime: "orbstack",
		});
		expect(orb.provider).toBe("orbstack");
		const login = await planSetup(w.deps, {
			report: reportWith([DOCTOR_CHECK.daemon]),
			startAtLogin: true,
		});
		expect(login.steps.at(-1)?.id).toBe(SETUP_STEP.colimaStartAtLogin);
	});

	test("an inspection failure is an unsupported plan, never a throw", async () => {
		const w = setupWorld(createPlatformFacts());
		w.platform.error = new Error("id: not found");
		const plan = await planSetup(w.deps, {});
		expect(plan.kind).toBe("unsupported");
		expect(plan.reason).toContain("id: not found");
	});
});

describe("startDockerRuntime", () => {
	test("already running: done, nothing runs", async () => {
		const w = setupWorld(
			createPlatformFacts({ dockerCliPath: "/usr/local/bin/docker" }),
		);
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["done", "Docker is already running."],
		]);
		expect(w.runner.calls).toEqual([]);
	});

	test("Colima stopped: starts it captured, waits, done", async () => {
		const w = setupWorld(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
		);
		w.down();
		w.runner.on(SETUP_STEP.colimaStart, () => {
			w.up();
			return { exitCode: 0, output: "colima is running" };
		});
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(w.runner.ranIds()).toEqual([SETUP_STEP.colimaStart]);
		expect(w.runner.calls[0]?.options.attached).toBe(false);
		expect(w.waiter.calls).toHaveLength(1);
		expect(events.some((e) => e.message === "colima is running")).toBe(true);
	});

	test("Docker Desktop stopped: open -a Docker", async () => {
		const w = setupWorld(
			createPlatformFacts({ installedRuntimes: ["docker-desktop"] }),
		);
		w.down();
		w.runner.on(SETUP_STEP.desktopStart, () => {
			w.platform.facts.dockerCliPath = "/usr/local/bin/docker";
			w.up();
			return {};
		});
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(w.runner.calls[0]?.step.argv).toEqual(["open", "-a", "Docker"]);
	});

	test("nothing installed: DOCKER_NOT_INSTALLED pointing at locastack setup", async () => {
		const w = setupWorld(createPlatformFacts());
		w.down();
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.error?.code).toBe("DOCKER_NOT_INSTALLED");
		expect(events[0]?.error?.details?.provider).toBe("colima");
		expect(String(events[0]?.error?.details?.fix)).toContain("locastack setup");
		expect(w.runner.calls).toEqual([]);
	});

	test("a provider that is not installed is not installed", async () => {
		const w = setupWorld(
			createPlatformFacts({
				installedRuntimes: ["colima"],
				dockerCliPath: "/opt/homebrew/bin/docker",
			}),
		);
		w.down();
		const events = await collect(
			startDockerRuntime(w.deps, {
				attached: false,
				provider: "docker-desktop",
			}),
		);
		expect(events[0]?.error?.code).toBe("DOCKER_NOT_INSTALLED");
		expect(w.runner.calls).toEqual([]);
	});

	test("Linux sudo start from the dashboard: SETUP_NEEDS_TERMINAL with the command", async () => {
		const w = setupWorld(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				inDockerGroup: true,
				dockerCliPath: "/usr/bin/docker",
			}),
		);
		w.down();
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.error?.code).toBe("SETUP_NEEDS_TERMINAL");
		expect(String(events[0]?.error?.details?.fix)).toContain(
			"sudo systemctl start docker",
		);
		expect(w.runner.calls).toEqual([]);
	});

	test("Linux sudo start from a terminal runs attached", async () => {
		const w = setupWorld(
			createLinuxPlatformFacts({
				installedRuntimes: ["docker-engine"],
				inDockerGroup: true,
				dockerCliPath: "/usr/bin/docker",
			}),
		);
		w.down();
		w.runner.on(SETUP_STEP.engineStart, () => {
			w.up();
			return {};
		});
		const events = await collect(
			startDockerRuntime(w.deps, { attached: true }),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(w.runner.calls[0]?.options.attached).toBe(true);
	});

	test("Windows: SETUP_UNSUPPORTED", async () => {
		const w = setupWorld(createPlatformFacts({ os: "win32" }));
		w.down();
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.error?.code).toBe("SETUP_UNSUPPORTED");
	});

	test("a failing start: SETUP_STEP_FAILED, no wait", async () => {
		const w = setupWorld(
			createPlatformFacts({ installedRuntimes: ["orbstack"] }),
		);
		w.down();
		w.runner.on(SETUP_STEP.orbstackStart, {
			exitCode: 1,
			output: "Unable to find application named 'OrbStack'",
		});
		const events = await collect(
			startDockerRuntime(w.deps, { attached: false }),
		);
		expect(events.at(-1)?.error?.code).toBe("SETUP_STEP_FAILED");
		expect(events.some((e) => e.message.includes("Unable to find"))).toBe(true);
		expect(w.waiter.calls).toEqual([]);
	});
});
