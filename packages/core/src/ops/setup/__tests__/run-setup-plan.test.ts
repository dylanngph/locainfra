import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { PlatformFacts } from "../../../ports/platform.port";
import type { CommandStep } from "../../../ports/process.port";
import { Progress } from "../../../shared/progress.model";
import { collect } from "../../../testing/collect";
import {
	createLinuxPlatformFacts,
	createPlatformFacts,
} from "../../../testing/setup-fakes";
import { DOCTOR_CHECK } from "../../doctor/doctor.model";
import {
	DOCKER_START_TIMEOUT_MS,
	SETUP_STEP_TIMEOUT_MS,
	type SetupPlan,
} from "../../ops.model";
import { buildSetupPlan } from "../build-setup-plan.op";
import { outputLines, runSetupPlan } from "../run-setup-plan.op";
import { SETUP_STEP } from "../setup-steps";
import { DOWN, reportWith, setupWorld } from "./setup-world";

const NOTHING = [DOCTOR_CHECK.dockerCli, ...DOWN, DOCTOR_CHECK.composePlugin];

function planFor(
	facts: PlatformFacts,
	fails = NOTHING,
	options: Parameters<typeof buildSetupPlan>[2] = {},
): SetupPlan {
	return buildSetupPlan(facts, reportWith(fails), options);
}

function noBrewFacts(): PlatformFacts {
	const facts = createPlatformFacts({
		hasBrew: false,
		dockerCliPath: "/opt/homebrew/bin/docker",
	});
	delete facts.brewPrefix;
	return facts;
}

function terminal(events: Progress[]): Progress[] {
	return events.filter((e) => e.kind === "done" || e.kind === "error");
}

function expectOneTerminal(events: Progress[]): Progress {
	const ends = terminal(events);
	expect(ends).toHaveLength(1);
	expect(events.at(-1)).toBe(ends[0] as Progress);
	for (const event of events) expect(Value.Check(Progress, event)).toBe(true);
	return ends[0] as Progress;
}

describe("runSetupPlan: shapes that run nothing", () => {
	test("none: done only", async () => {
		const w = setupWorld(createPlatformFacts());
		const events = await collect(
			runSetupPlan(w.deps, {
				plan: planFor(createPlatformFacts(), []),
				attached: true,
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["done"]);
		expect(w.runner.calls).toEqual([]);
	});

	test("unsupported: SETUP_UNSUPPORTED with the notes as fix", async () => {
		const facts = createPlatformFacts({ os: "win32" });
		const w = setupWorld(facts);
		const events = await collect(
			runSetupPlan(w.deps, { plan: planFor(facts), attached: true }),
		);
		const end = expectOneTerminal(events);
		expect(end.error?.code).toBe("SETUP_UNSUPPORTED");
		expect(String(end.error?.details?.fix)).toContain("windows-install");
		expect(w.runner.calls).toEqual([]);
	});

	test("needsTerminal without a terminal: SETUP_NEEDS_TERMINAL naming the commands", async () => {
		const facts = createLinuxPlatformFacts({
			installedRuntimes: ["docker-engine"],
			inDockerGroup: true,
		});
		const w = setupWorld(facts);
		const events = await collect(
			runSetupPlan(w.deps, { plan: planFor(facts, DOWN), attached: false }),
		);
		const end = expectOneTerminal(events);
		expect(end.error?.code).toBe("SETUP_NEEDS_TERMINAL");
		expect(end.error?.details?.commands).toEqual([
			"sudo systemctl start docker",
		]);
		expect(String(end.error?.details?.fix)).toContain(
			"`sudo systemctl start docker`",
		);
		expect(w.runner.calls).toEqual([]);
	});
});

describe("runSetupPlan: success", () => {
	test("Colima install from a terminal: every step, wait, doctor, done with notes", async () => {
		const facts = createPlatformFacts();
		const w = setupWorld(facts);
		w.down();
		w.runner.on(SETUP_STEP.colimaInstall, () => {
			w.platform.facts.dockerCliPath = "/opt/homebrew/bin/docker";
			return { exitCode: 0 };
		});
		w.runner.on(SETUP_STEP.colimaStart, () => {
			w.up();
			return { exitCode: 0 };
		});
		const plan = planFor(facts);
		const events = await collect(
			runSetupPlan(w.deps, { plan, attached: true }),
		);
		const end = expectOneTerminal(events);
		expect(end.kind).toBe("done");
		expect(end.message).toContain(
			"Docker is ready: Engine 29.6.1 (Docker Desktop 4.82.0), linux/aarch64",
		);
		expect(end.message).toContain("brew services start colima");
		expect(w.runner.ranIds()).toEqual(plan.steps.map((s) => s.id));
		expect(w.runner.calls.every((c) => c.options.attached)).toBe(true);
		expect(w.runner.calls[0]?.options.timeoutMs).toBeUndefined();
		expect(w.waiter.calls).toEqual([DOCKER_START_TIMEOUT_MS]);
		const steps = events.filter((e) => e.kind === "step").map((e) => e.message);
		expect(steps).toEqual([
			...plan.steps.map((s) => s.title),
			"Waiting for Colima to answer (up to 180 s)",
			"Checking Docker",
		]);
		expect(events.filter((e) => e.kind === "step")[0]?.percent).toBe(0);
		expect(
			events.filter((e) => e.kind === "log").map((e) => e.message),
		).toContain(`Done: ${plan.steps[0]?.title}`);
	});

	test("captured run (server): default step deadline and output streamed as logs", async () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["colima"],
			dockerCliPath: "/opt/homebrew/bin/docker",
		});
		const w = setupWorld(facts);
		w.runner.on(SETUP_STEP.colimaStart, {
			output:
				"\u001b[32mINFO\u001b[0m starting colima\n\nprogress 10%\rprogress 100%\n",
		});
		const events = await collect(
			runSetupPlan(w.deps, {
				plan: planFor(facts, DOWN),
				attached: false,
				waitTimeoutMs: 5000,
			}),
		);
		expect(expectOneTerminal(events).kind).toBe("done");
		expect(w.runner.calls[0]?.options).toEqual({
			attached: false,
			timeoutMs: SETUP_STEP_TIMEOUT_MS,
		});
		expect(w.waiter.calls).toEqual([5000]);
		const logs = events.filter((e) => e.kind === "log").map((e) => e.message);
		expect(logs).toEqual([
			"INFO starting colima",
			"progress 100%",
			"Done: Starting Colima (the first start downloads a VM image)",
		]);
	});

	test("a step's own timeout wins", async () => {
		const facts = createPlatformFacts({ installedRuntimes: ["orbstack"] });
		const w = setupWorld(facts);
		const plan = planFor(facts, DOWN);
		const step = { ...(plan.steps[0] as CommandStep), timeoutMs: 1234 };
		await collect(
			runSetupPlan(w.deps, {
				plan: { ...plan, steps: [step] },
				attached: false,
			}),
		);
		expect(w.runner.calls[0]?.options.timeoutMs).toBe(1234);
	});

	test("docker group added: no wait, done explains the re-login", async () => {
		const facts = createLinuxPlatformFacts();
		const w = setupWorld(facts);
		w.down();
		const plan = planFor(facts, [...NOTHING, DOCTOR_CHECK.dockerGroup]);
		const events = await collect(
			runSetupPlan(w.deps, { plan, attached: true }),
		);
		const end = expectOneTerminal(events);
		expect(end.kind).toBe("done");
		expect(end.message).toContain("log out and back in");
		expect(end.message).toContain("newgrp docker");
		expect(w.waiter.calls).toEqual([]);
		expect(w.runner.ranIds()).toEqual([
			SETUP_STEP.engineDownload,
			SETUP_STEP.engineInstall,
			SETUP_STEP.engineEnable,
			SETUP_STEP.groupAdd,
		]);
	});
});

describe("runSetupPlan: failures", () => {
	const macPlan = planFor(noBrewFacts());
	const linuxPlan = planFor(createLinuxPlatformFacts());

	for (const [name, facts, plan] of [
		["macOS (Homebrew + Colima)", noBrewFacts(), macPlan],
		["Linux (get.docker.com)", createLinuxPlatformFacts(), linuxPlan],
	] as const) {
		for (const [index, step] of plan.steps.entries()) {
			test(`${name}: failing at ${step.id} stops there with a fix`, async () => {
				const w = setupWorld(facts);
				w.runner.on(step.id, { exitCode: 1 });
				const events = await collect(
					runSetupPlan(w.deps, { plan, attached: true }),
				);
				const end = expectOneTerminal(events);
				expect(end.error?.code).toBe("SETUP_STEP_FAILED");
				expect(end.message).toBe(`${step.title} failed (exit code 1)`);
				expect(end.error?.details).toMatchObject({
					stepId: step.id,
					exitCode: 1,
					stepTimedOut: false,
				});
				expect(end.error?.details).not.toHaveProperty("timedOut");
				expect(String(end.error?.details?.fix).length).toBeGreaterThan(10);
				expect(w.runner.ranIds()).toEqual(
					plan.steps.slice(0, index + 1).map((s) => s.id),
				);
				expect(w.waiter.calls).toEqual([]);
			});
		}
	}

	test("specific fixes: Homebrew cancelled, download, install script", async () => {
		const cases = [
			[macPlan, SETUP_STEP.brewInstall, "Homebrew installation was cancelled"],
			[
				macPlan,
				SETUP_STEP.brewDownload,
				"Could not download https://raw.githubusercontent.com",
			],
			[
				linuxPlan,
				SETUP_STEP.engineDownload,
				"Could not download https://get.docker.com",
			],
			[linuxPlan, SETUP_STEP.engineInstall, "Docker's install script failed"],
			[linuxPlan, SETUP_STEP.groupAdd, "`sudo usermod -aG docker test`"],
			[linuxPlan, SETUP_STEP.engineEnable, "a wrong sudo password"],
		] as const;
		for (const [plan, id, text] of cases) {
			const w = setupWorld(createPlatformFacts());
			w.runner.on(id, { exitCode: 1 });
			const end = terminal(
				await collect(runSetupPlan(w.deps, { plan, attached: true })),
			)[0];
			expect(String(end?.error?.details?.fix)).toContain(text);
		}
	});

	test("timed out, missing binary and spawn errors", async () => {
		const facts = createPlatformFacts({ installedRuntimes: ["colima"] });
		const plan = planFor(facts, DOWN);
		const timedOut = setupWorld(facts);
		timedOut.runner.on(SETUP_STEP.colimaStart, {
			exitCode: -1,
			timedOut: true,
		});
		const a = terminal(
			await collect(runSetupPlan(timedOut.deps, { plan, attached: false })),
		)[0];
		expect(a?.message).toContain("timed out");
		expect(a?.error?.details?.stepTimedOut).toBe(true);

		const missing = setupWorld(facts);
		missing.runner.on(SETUP_STEP.colimaStart, { exitCode: 127 });
		const b = terminal(
			await collect(runSetupPlan(missing.deps, { plan, attached: true })),
		)[0];
		expect(b?.message).toContain("`colima` was not found");
		expect(String(b?.error?.details?.fix)).toContain("`colima` was not found");

		const spawn = setupWorld(facts);
		spawn.runner.on(SETUP_STEP.colimaStart, new Error("spawn EPERM"));
		const c = terminal(
			await collect(runSetupPlan(spawn.deps, { plan, attached: true })),
		)[0];
		expect(c?.error?.code).toBe("SETUP_STEP_FAILED");
		expect(c?.error?.details?.exitCode).toBe(-1);
		expect(c?.message).toContain("spawn EPERM");
	});

	test("beforeStep abort after the download: SETUP_CANCELLED, script never runs", async () => {
		const facts = createLinuxPlatformFacts();
		const w = setupWorld(facts);
		const seen: [string, number][] = [];
		const events = await collect(
			runSetupPlan(w.deps, {
				plan: linuxPlan,
				attached: true,
				beforeStep: async (step, index, plan) => {
					expect(plan).toBe(linuxPlan);
					seen.push([step.id, index]);
					return step.id === SETUP_STEP.engineInstall ? "abort" : "run";
				},
			}),
		);
		const end = expectOneTerminal(events);
		expect(end.error?.code).toBe("SETUP_CANCELLED");
		expect(end.error?.details?.stepId).toBe(SETUP_STEP.engineInstall);
		expect(seen).toEqual([
			[SETUP_STEP.engineDownload, 0],
			[SETUP_STEP.engineInstall, 1],
		]);
		expect(w.runner.ranIds()).toEqual([SETUP_STEP.engineDownload]);
	});

	test("an aborted signal cancels before the first step and during the wait", async () => {
		const facts = createPlatformFacts({ installedRuntimes: ["colima"] });
		const plan = planFor(facts, DOWN);
		const before = setupWorld(facts);
		const first = terminal(
			await collect(
				runSetupPlan(before.deps, {
					plan,
					attached: true,
					signal: AbortSignal.abort(),
				}),
			),
		)[0];
		expect(first?.error?.code).toBe("SETUP_CANCELLED");
		expect(before.runner.calls).toEqual([]);

		const during = setupWorld(facts);
		const controller = new AbortController();
		during.runner.on(SETUP_STEP.colimaStart, () => {
			controller.abort();
			return { exitCode: 0 };
		});
		const second = terminal(
			await collect(
				runSetupPlan(during.deps, {
					plan,
					attached: true,
					signal: controller.signal,
				}),
			),
		)[0];
		expect(second?.error?.code).toBe("SETUP_CANCELLED");
		expect(during.waiter.calls).toEqual([]);
	});

	test("daemon never answers: DOCKER_START_TIMEOUT with a provider fix", async () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["docker-desktop"],
		});
		const w = setupWorld(facts);
		w.waiter.ready = false;
		const end = expectOneTerminal(
			await collect(
				runSetupPlan(w.deps, { plan: planFor(facts, DOWN), attached: true }),
			),
		);
		expect(end.error?.code).toBe("DOCKER_START_TIMEOUT");
		expect(end.message).toBe("Docker Desktop did not answer within 180 s.");
		expect(String(end.error?.details?.fix)).toContain("its own window");
	});

	test("the final doctor still failing maps to the check's error code", async () => {
		const facts = createPlatformFacts({
			installedRuntimes: ["colima"],
			dockerCliPath: "/opt/homebrew/bin/docker",
		});
		const w = setupWorld(facts);
		w.compose.current = null;
		const end = expectOneTerminal(
			await collect(
				runSetupPlan(w.deps, { plan: planFor(facts, DOWN), attached: true }),
			),
		);
		expect(end.error?.code).toBe("COMPOSE_MISSING");
		expect(end.error?.details?.checkId).toBe(DOCTOR_CHECK.composePlugin);

		const old = setupWorld(facts);
		old.compose.current = "2.20.0";
		const oldEnd = terminal(
			await collect(
				runSetupPlan(old.deps, { plan: planFor(facts, DOWN), attached: true }),
			),
		)[0];
		expect(oldEnd?.error?.code).toBe("COMPOSE_TOO_OLD");

		const down = setupWorld(facts);
		down.down();
		const downEnd = terminal(
			await collect(
				runSetupPlan(down.deps, { plan: planFor(facts, DOWN), attached: true }),
			),
		)[0];
		expect(downEnd?.error?.code).toBe("DOCKER_UNREACHABLE");
	});

	test("an unexpected throw ends with one UNKNOWN error", async () => {
		const facts = createPlatformFacts({ installedRuntimes: ["colima"] });
		const w = setupWorld(facts);
		const end = expectOneTerminal(
			await collect(
				runSetupPlan(w.deps, {
					plan: planFor(facts, DOWN),
					attached: true,
					beforeStep: async () => {
						throw new Error("prompt closed");
					},
				}),
			),
		);
		expect(end.error?.code).toBe("UNKNOWN");
		expect(end.message).toContain("prompt closed");
	});
});

describe("outputLines", () => {
	test("keeps the last 200 lines", () => {
		const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
		const lines = outputLines(text);
		expect(lines).toHaveLength(200);
		expect(lines[0]).toBe("line 50");
	});
});

describe("runSetupPlan: fresh Homebrew off PATH (review fix)", () => {
	test("prepends the brew prefix before the wait and doctor, so both find the new docker", async () => {
		const facts = createPlatformFacts({ hasBrew: false });
		delete facts.brewPrefix;
		const plan = planFor(facts);
		expect(plan.pathAdditions).toEqual([
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
		]);
		const w = setupWorld(facts);
		w.down();
		const onPath = (): boolean => w.runner.path.includes("/opt/homebrew/bin");
		// The locator (`docker context inspect`) and `which docker` only
		// succeed once the prefix is on this process's PATH.
		w.waiter.waitForDocker = async () => {
			if (!onPath()) return false;
			w.up();
			return true;
		};
		w.platform.facts = { ...facts, dockerCliPath: undefined };
		const inspect = w.platform.inspect.bind(w.platform);
		w.platform.inspect = async () => {
			const current = await inspect();
			return onPath()
				? {
						...current,
						hasBrew: true,
						brewPrefix: "/opt/homebrew",
						dockerCliPath: "/opt/homebrew/bin/docker",
					}
				: current;
		};
		const end = expectOneTerminal(
			await collect(runSetupPlan(w.deps, { plan, attached: true })),
		);
		expect(end.kind).toBe("done");
		expect(w.runner.pathPrepends).toEqual([
			["/opt/homebrew/bin", "/opt/homebrew/sbin"],
		]);
		expect(end.message).toContain("brew shellenv");
	});

	test("without the prefix the wait times out; the fix carries the plan's notes", async () => {
		const facts = createPlatformFacts({ hasBrew: false });
		delete facts.brewPrefix;
		const plan = { ...planFor(facts), pathAdditions: undefined };
		const w = setupWorld(facts);
		w.down();
		w.waiter.ready = false;
		const end = expectOneTerminal(
			await collect(
				runSetupPlan(w.deps, { plan, attached: true, waitTimeoutMs: 1_000 }),
			),
		);
		expect(end.error?.code).toBe("DOCKER_START_TIMEOUT");
		expect(String(end.error?.details?.fix)).toContain("colima status");
		expect(String(end.error?.details?.fix)).toContain("brew shellenv");
		expect(end.error?.details?.notes).toEqual(plan.postNotes);
		expect(w.runner.pathPrepends).toEqual([]);
	});
});
