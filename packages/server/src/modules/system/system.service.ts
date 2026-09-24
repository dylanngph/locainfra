import {
	type GetSystemInfo,
	type GetSystemInfoDeps,
	OpError,
	type PlanSetup,
	type RunDoctor,
	type SetupPlan,
	type StartDockerRuntime,
	type StartDockerRuntimeDeps,
} from "@locastack/core";
import type { OpAccepted } from "../../models/common.model";
import type { OpInfo, OpLauncher } from "../observer/op-registry";
import type {
	StartDockerRequest,
	SystemSetup,
	SystemStatus,
} from "./system.model";

/** Core ops used by {@link SystemService} (field names match `ServerOps`). */
export interface SystemOps {
	/** Docker/compose versions (`GET /api/system`). */
	readonly getSystemInfo: GetSystemInfo;
	/** Diagnostics (`GET /api/system/setup`). */
	readonly runDoctor: RunDoctor;
	/** Setup planner; never executes anything. */
	readonly planSetup: PlanSetup;
	/** Starts an installed runtime (`POST /api/system/docker/start`). */
	readonly startDockerRuntime: StartDockerRuntime;
}

/**
 * Ports used by {@link SystemService}: the versions ports plus the setup
 * ports (`platform`, `runner`, `waiter` and the doctor slice as `doctor`).
 */
export type SystemPorts = GetSystemInfoDeps & StartDockerRuntimeDeps;

/** Launcher of the Start Docker op; `get` lets a second click join the running op. */
export type SystemLauncher = OpLauncher & {
	/**
	 * @param id - Operation id.
	 * @returns Its public view, or `undefined` when unknown or expired.
	 */
	get(id: string): OpInfo | undefined;
};

/** What {@link SystemService} is built from (wired by `createApp`). */
export interface SystemServiceOptions {
	/** Core ops. */
	readonly ops: SystemOps;
	/** Ports passed to the ops. */
	readonly ports: SystemPorts;
	/** Operation registry (Start Docker answers `202 { opId }`). */
	readonly launcher: SystemLauncher;
	/** LocaStack version reported to the UI. */
	readonly dashboardVersion: string;
}

/** `kind` of the Start Docker op in the registry (`GET /api/ops`). */
export const DOCKER_START_OP_KIND = "docker.start";

/**
 * Docker/compose versions for the header status dot, the setup plan for the
 * dashboard's Docker-unavailable screen and its Start Docker action. No HTTP
 * knowledge; nothing here installs anything.
 */
export class SystemService {
	/** Id of the last Start Docker op (joined while it still runs). */
	private startOpId: string | undefined;
	/** Start request still planning (a concurrent click joins it). */
	private starting: Promise<OpAccepted> | undefined;

	/** @param options - Ops, ports, launcher and version. */
	constructor(private readonly options: SystemServiceOptions) {}

	/** @returns Versions; `docker`/`compose` are `null` when unreachable/missing. */
	async status(): Promise<SystemStatus> {
		const { ops, ports, dashboardVersion } = this.options;
		const info = await ops.getSystemInfo(ports);
		return { ...info, dashboardVersion };
	}

	/**
	 * Runs doctor once and plans the remedy from that report. Executes nothing.
	 *
	 * @returns The fresh report and the plan (`kind: "none"` when Docker works).
	 */
	async setup(): Promise<SystemSetup> {
		const { ops, ports } = this.options;
		const doctor = await ops.runDoctor(ports.doctor);
		const plan = await ops.planSetup(
			{ platform: ports.platform, doctor: ports.doctor },
			{ report: doctor },
		);
		return { doctor, plan };
	}

	/**
	 * Starts the installed-but-stopped runtime in the background (captured
	 * output, never attached). Plans first so the common dead ends answer
	 * directly instead of as a failed op. A second call while a start is still
	 * running returns the same op id. Docker already running → an op that
	 * ends with `done` straight away.
	 *
	 * @param body - Optional runtime to start when several are installed.
	 * @returns The operation id (progress on `op:<opId>`).
	 * @throws OpError `DOCKER_NOT_INSTALLED` (nothing to start: run
	 * `locastack setup`), `SETUP_UNSUPPORTED`, `SETUP_NEEDS_TERMINAL` (the
	 * start needs sudo, e.g. `systemctl` on Linux); all `409` with
	 * `details.fix`.
	 */
	startDocker(body: StartDockerRequest): Promise<OpAccepted> {
		const { launcher } = this.options;
		const running =
			this.startOpId === undefined ? undefined : launcher.get(this.startOpId);
		if (running?.state === "running")
			return Promise.resolve({ opId: running.id });
		if (this.starting !== undefined) return this.starting;
		const starting = this.launchStart(body).finally(() => {
			this.starting = undefined;
		});
		this.starting = starting;
		return starting;
	}

	/**
	 * @param body - Optional runtime.
	 * @returns The new operation id.
	 * @throws OpError see {@link SystemService.startDocker}.
	 */
	private async launchStart(body: StartDockerRequest): Promise<OpAccepted> {
		const { ops, ports, launcher } = this.options;
		const provider = body.provider;
		const plan = await ops.planSetup(
			{ platform: ports.platform, doctor: ports.doctor },
			provider === undefined ? {} : { runtime: provider },
		);
		assertStartable(plan);

		const opId = launcher.start({
			kind: DOCKER_START_OP_KIND,
			run: () =>
				ops.startDockerRuntime(ports, {
					attached: false,
					...(provider === undefined ? {} : { provider }),
				}),
		});
		this.startOpId = opId;
		return { opId };
	}
}

/** Manual command offered when the dashboard cannot run the plan itself. */
const SETUP_COMMAND = "locastack setup";

/**
 * Rejects plans the dashboard cannot run (see {@link SystemService.startDocker}).
 *
 * @param plan - Fresh plan.
 * @throws OpError with a `fix` for install, unsupported and terminal-only plans.
 */
function assertStartable(plan: SetupPlan): void {
	switch (plan.kind) {
		case "none":
			return;
		case "install":
			throw new OpError("DOCKER_NOT_INSTALLED", plan.reason, {
				details: {
					fix: `Run \`${SETUP_COMMAND}\` in a terminal`,
					command: SETUP_COMMAND,
				},
			});
		case "unsupported":
			throw new OpError("SETUP_UNSUPPORTED", plan.reason, {
				details:
					plan.postNotes.length > 0 ? { fix: plan.postNotes.join(" ") } : {},
			});
		case "start":
			if (plan.needsTerminal)
				throw new OpError(
					"SETUP_NEEDS_TERMINAL",
					`${plan.reason} Starting it needs a terminal (sudo).`,
					{
						details: {
							fix: `Run \`${SETUP_COMMAND}\` in a terminal`,
							command: SETUP_COMMAND,
						},
					},
				);
			return;
	}
}
