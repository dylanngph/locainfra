import {
	DoctorReport,
	RuntimeProvider,
	SetupPlan,
	SystemInfo,
} from "@locastack/core";
import { t } from "elysia";

/** `GET /api/system` response: Docker/compose versions plus the dashboard's own version. */
export const SystemStatus = t.Composite([
	SystemInfo,
	t.Object({
		dashboardVersion: t.String({ description: "LocaStack version" }),
	}),
]);
/** `GET /api/system` response. */
export type SystemStatus = typeof SystemStatus.static;

/**
 * `GET /api/system/setup` response: a fresh doctor report and the setup plan
 * for the current machine (never executed by this route). The dashboard's
 * Docker-unavailable screen shows `plan.reason`, a Start Docker button when
 * `plan.kind` is `start` and `!plan.needsTerminal`, else the copyable
 * `locastack setup` command.
 */
export const SystemSetup = t.Object({
	doctor: DoctorReport,
	plan: SetupPlan,
});
/** `GET /api/system/setup` response. */
export type SystemSetup = typeof SystemSetup.static;

/** `POST /api/system/docker/start` body (optional). */
export const StartDockerRequest = t.Object({
	provider: t.Optional(RuntimeProvider),
});
/** `POST /api/system/docker/start` body. */
export type StartDockerRequest = typeof StartDockerRequest.static;

/** Reference models of the system controller, registered under `System.`. */
export const SystemModel = {
	status: SystemStatus,
	setup: SystemSetup,
	startDocker: StartDockerRequest,
};
