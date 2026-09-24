import { api, unwrap } from "@/shared/lib/api";

/**
 * `GET /api/system/setup`: a fresh doctor report and the setup plan for this
 * machine. The server never executes anything for this call.
 *
 * @returns `{ doctor, plan }`.
 */
export const fetchSystemSetup = () => unwrap(api.api.system.setup.get());

/** `GET /api/system/setup` response. */
export type SystemSetup = Awaited<ReturnType<typeof fetchSystemSetup>>;
/** The setup plan (`kind`, `reason`, `steps`, `postNotes`, `needsTerminal`…). */
export type SetupPlan = SystemSetup["plan"];
/** One command of a setup plan. */
export type SetupStep = SetupPlan["steps"][number];
/** One doctor check. */
export type SystemCheck = SystemSetup["doctor"]["checks"][number];
/** A runtime the server can plan for (`colima`, `docker-desktop`, `orbstack`, `docker-engine`). */
export type RuntimeProvider = SetupPlan["alternatives"][number];

/**
 * `POST /api/system/docker/start`: starts the installed-but-stopped runtime
 * in the background. `409` (`DOCKER_NOT_INSTALLED`, `SETUP_NEEDS_TERMINAL`,
 * `SETUP_UNSUPPORTED`) when the dashboard cannot start it.
 *
 * @param provider - Runtime to start when several are installed.
 * @returns The op id (progress via `GET /api/ops/:opId/events`).
 */
export const startDocker = async (provider?: RuntimeProvider) =>
	(await unwrap(api.api.system.docker.start.post(provider ? { provider } : {})))
		.opId;
