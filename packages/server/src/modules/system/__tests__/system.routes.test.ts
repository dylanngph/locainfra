import { describe, expect, it } from "bun:test";
import type {
	DoctorReport,
	PlanSetupDeps,
	PlanSetupInput,
	Progress,
	RunDoctorDeps,
	SetupPlan,
	StartDockerRuntimeDeps,
	StartDockerRuntimeInput,
} from "@locastack/core";
import {
	FakeComposeInfo,
	FakeDaemonWaiter,
	FakeDockerInfo,
	FakePlatformInspector,
	FakeProcessRunner,
	FakeSocketLocator,
	FixedClock,
} from "@locastack/core/testing";
import { Elysia } from "elysia";
import { errorHandler } from "../../../plugins/error-handler";
import { OpRegistry } from "../../observer/op-registry";
import { systemModule } from "..";
import {
	DOCKER_START_OP_KIND,
	type SystemOps,
	type SystemPorts,
	SystemService,
} from "../system.service";

const REPORT_DOWN: DoctorReport = {
	ok: false,
	generatedAt: "2026-09-24T08:00:00.000Z",
	checks: [
		{ id: "docker.cli", label: "Docker CLI", status: "ok" },
		{
			id: "docker.daemon",
			label: "Docker daemon",
			status: "fail",
			detail: "not reachable",
			fix: "Start Colima: colima start",
		},
	],
	setupNeeded: "start",
};

const START_PLAN: SetupPlan = {
	kind: "start",
	provider: "colima",
	alternatives: [],
	reason: "Colima is installed but not running; start it.",
	steps: [
		{ id: "colima.start", title: "Starting Colima", argv: ["colima", "start"] },
	],
	postNotes: [],
	needsTerminal: false,
};

const plan = (overrides: Partial<SetupPlan>): SetupPlan => ({
	...START_PLAN,
	...overrides,
});

/** Stub ops (core's setup ops are injected, never run for real) and their call log. */
function createFixture(
	options: {
		plan?: SetupPlan;
		report?: DoctorReport;
		events?: Progress[];
		/** When set, the start op waits for this promise before its terminal event. */
		gate?: Promise<void>;
	} = {},
) {
	const calls: {
		doctor: RunDoctorDeps[];
		plan: { deps: PlanSetupDeps; input: PlanSetupInput }[];
		start: { deps: StartDockerRuntimeDeps; input: StartDockerRuntimeInput }[];
	} = { doctor: [], plan: [], start: [] };
	const doctorDeps: RunDoctorDeps = {
		docker: new FakeDockerInfo(),
		compose: new FakeComposeInfo(),
		socket: new FakeSocketLocator(),
		clock: new FixedClock("2026-09-24T08:00:00.000Z"),
		platform: new FakePlatformInspector(),
	};
	const runner = new FakeProcessRunner();
	const ports: SystemPorts = {
		docker: doctorDeps.docker,
		compose: doctorDeps.compose,
		platform: doctorDeps.platform,
		doctor: doctorDeps,
		runner,
		waiter: new FakeDaemonWaiter(),
	};
	const ops: SystemOps = {
		getSystemInfo: async () => ({
			docker: null,
			compose: null,
		}),
		runDoctor: async (deps) => {
			calls.doctor.push(deps);
			return options.report ?? REPORT_DOWN;
		},
		planSetup: async (deps, input) => {
			calls.plan.push({ deps, input });
			return options.plan ?? START_PLAN;
		},
		startDockerRuntime: (deps, input) => {
			calls.start.push({ deps, input });
			const events = options.events ?? [
				{ kind: "step", message: "Starting Colima" },
				{ kind: "done", message: "Docker is ready: 28.0.0" },
			];
			const gate = options.gate;
			return (async function* () {
				for (const event of events.slice(0, -1)) yield event;
				if (gate) await gate;
				const last = events.at(-1);
				if (last) yield last;
			})();
		},
	};
	const registry = new OpRegistry();
	const service = new SystemService({
		ops,
		ports,
		launcher: registry,
		dashboardVersion: "0.2.0",
	});
	const app = new Elysia().use(errorHandler).use(systemModule(service));
	const call = (method: string, path: string, body?: unknown) =>
		app.handle(
			new Request(`http://127.0.0.1${path}`, {
				method,
				...(body === undefined
					? {}
					: {
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}),
			}),
		);
	return { app, call, calls, registry, runner, ports };
}

describe("GET /api/system/setup", () => {
	it("returns the doctor report and the plan built from that same report", async () => {
		const { call, calls, ports } = createFixture();
		const response = await call("GET", "/api/system/setup");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			doctor: REPORT_DOWN,
			plan: START_PLAN,
		});
		expect(calls.doctor).toEqual([ports.doctor]);
		expect(calls.plan).toHaveLength(1);
		expect(calls.plan[0]?.input).toEqual({ report: REPORT_DOWN });
		expect(calls.plan[0]?.deps.platform).toBe(ports.platform);
	});

	it("never runs a command or starts anything", async () => {
		const { call, calls, runner } = createFixture({
			plan: plan({ kind: "install" }),
		});
		await call("GET", "/api/system/setup");
		expect(runner.calls).toEqual([]);
		expect(calls.start).toEqual([]);
	});
});

describe("GET /api/system", () => {
	it("still reports versions and the dashboard version", async () => {
		const { call } = createFixture();
		const response = await call("GET", "/api/system");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			docker: null,
			compose: null,
			dashboardVersion: "0.2.0",
		});
	});
});

describe("POST /api/system/docker/start", () => {
	it("registers startDockerRuntime (not attached) and answers 202 { opId }", async () => {
		const { call, calls, registry, ports } = createFixture();
		const response = await call("POST", "/api/system/docker/start", {});
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		const settled = await registry.settled(opId);
		expect(settled).toMatchObject({
			kind: DOCKER_START_OP_KIND,
			state: "done",
		});
		expect(calls.start).toHaveLength(1);
		expect(calls.start[0]?.input).toEqual({ attached: false });
		expect(calls.start[0]?.deps).toBe(ports);
	});

	it("passes the requested provider to the planner and the op", async () => {
		const { call, calls, registry } = createFixture();
		const response = await call("POST", "/api/system/docker/start", {
			provider: "orbstack",
		});
		const { opId } = (await response.json()) as { opId: string };
		await registry.settled(opId);
		expect(calls.plan[0]?.input).toEqual({ runtime: "orbstack" });
		expect(calls.start[0]?.input).toEqual({
			attached: false,
			provider: "orbstack",
		});
	});

	it("streams the op's events on op:<opId>", async () => {
		const { call, registry } = createFixture();
		const response = await call("POST", "/api/system/docker/start", {});
		const { opId } = (await response.json()) as { opId: string };
		await registry.settled(opId);
		const seen: Progress[] = [];
		registry.subscribe(opId, (event) => seen.push(event));
		expect(seen.map((e) => e.kind)).toEqual(["step", "done"]);
		expect(seen.every((e) => e.opId === opId)).toBe(true);
	});

	it("joins the running start instead of launching a second one", async () => {
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const { call, calls, registry } = createFixture({ gate });
		const [a, b] = await Promise.all([
			call("POST", "/api/system/docker/start", {}),
			call("POST", "/api/system/docker/start", {}),
		]);
		const first = (await a.json()) as { opId: string };
		const second = (await b.json()) as { opId: string };
		const third = (await (
			await call("POST", "/api/system/docker/start", {})
		).json()) as { opId: string };
		expect(second.opId).toBe(first.opId);
		expect(third.opId).toBe(first.opId);
		open();
		await registry.settled(first.opId);
		expect(calls.start).toHaveLength(1);

		const again = (await (
			await call("POST", "/api/system/docker/start", {})
		).json()) as { opId: string };
		expect(again.opId).not.toBe(first.opId);
	});

	it("409s DOCKER_NOT_INSTALLED with the setup command when nothing is installed", async () => {
		const { call, calls } = createFixture({
			plan: plan({
				kind: "install",
				reason: "Docker is not installed; install Colima.",
				needsTerminal: true,
			}),
		});
		const response = await call("POST", "/api/system/docker/start", {});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			code: "DOCKER_NOT_INSTALLED",
			message: "Docker is not installed; install Colima.",
			details: {
				fix: "Run `locastack setup` in a terminal",
				command: "locastack setup",
			},
		});
		expect(calls.start).toEqual([]);
	});

	it("409s SETUP_NEEDS_TERMINAL for a sudo start (Linux systemctl)", async () => {
		const { call, calls } = createFixture({
			plan: plan({
				provider: "docker-engine",
				reason: "Docker Engine is installed but stopped; start it.",
				steps: [
					{
						id: "docker.start",
						title: "Starting Docker",
						argv: ["sudo", "systemctl", "start", "docker"],
						sudo: true,
					},
				],
				needsTerminal: true,
			}),
		});
		const response = await call("POST", "/api/system/docker/start", {});
		expect(response.status).toBe(409);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("SETUP_NEEDS_TERMINAL");
		expect(calls.start).toEqual([]);
	});

	it("409s SETUP_UNSUPPORTED with the manual notes as the fix", async () => {
		const { call } = createFixture({
			plan: plan({
				kind: "unsupported",
				provider: undefined,
				steps: [],
				reason: "Windows is not supported yet.",
				postNotes: ["Install Docker Desktop manually."],
			}),
		});
		const response = await call("POST", "/api/system/docker/start", {});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			code: "SETUP_UNSUPPORTED",
			message: "Windows is not supported yet.",
			details: { fix: "Install Docker Desktop manually." },
		});
	});

	it("still starts an op when Docker already runs (the op ends with done)", async () => {
		const { call, registry } = createFixture({
			plan: plan({ kind: "none", provider: undefined, steps: [] }),
			events: [{ kind: "done", message: "Docker is already running" }],
		});
		const response = await call("POST", "/api/system/docker/start", {});
		expect(response.status).toBe(202);
		const { opId } = (await response.json()) as { opId: string };
		expect(await registry.settled(opId)).toMatchObject({ state: "done" });
	});

	it("rejects an unknown provider (422) and a missing body (422)", async () => {
		const { call, calls } = createFixture();
		expect(
			(await call("POST", "/api/system/docker/start", { provider: "podman" }))
				.status,
		).toBe(422);
		expect((await call("POST", "/api/system/docker/start")).status).toBe(422);
		expect(calls.plan).toEqual([]);
	});
});
