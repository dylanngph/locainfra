import type {
	ContainerDetails,
	ContainerHealth,
	ContainerSummary,
} from "../../ports/docker.port";
import {
	LABEL_INSTANCE,
	LABEL_SERVICE,
	LABEL_STACK,
} from "../../render/labels";
import type { ResolvedService } from "../../resolve/resolved.model";
import { UNPROVISIONED_PORT } from "../../resolve/resolver";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import type { ContainerViewDeps } from "../ops.contract";
import type {
	ProjectStatus,
	ServiceProblem,
	ServiceState,
	ServiceStatus,
} from "../ops.model";
import { suggestFreePort } from "./ports";
import type { ProjectView } from "./project-view";

/** Docker error text of a container that could not bind its host port. */
export const PORT_IN_USE_PATTERN =
	/port is already allocated|address already in use|bind: .*in use/i;

/**
 * Exit codes of a container stopped on purpose (`docker stop` sends SIGTERM,
 * then SIGKILL after the timeout): reported as `stopped`, not `error`.
 */
export const STOP_EXIT_CODES: ReadonlySet<number> = new Set([0, 137, 143]);

/** Container-derived part of a {@link ServiceStatus}. */
export interface ContainerClassification {
	/** Dashboard state. */
	readonly state: ServiceState;
	/** Container health (`none` without a container or healthcheck). */
	readonly health: ContainerHealth;
	/** Container id, when a container exists. */
	readonly containerId?: string;
	/** Start time while running. */
	readonly startedAt?: string;
	/** Why the service is in `error` / `port-conflict`. */
	readonly problem?: ServiceProblem;
	/** Whether the container holds its port (running or starting). */
	readonly active: boolean;
}

/**
 * Maps a container (list summary plus optional inspect details) to a
 * dashboard state:
 *
 * - no container → `stopped`;
 * - Docker's `State.Error` mentions a busy port → `port-conflict`;
 * - `running` → `running`, or `starting` while health is `starting`, or
 *   `error` when `unhealthy`;
 * - `created` / `restarting` → `starting`; `paused` / `removing` → `stopped`;
 * - `exited` with code 0, 137 or 143 → `stopped`, other codes → `error`;
 * - `dead` → `error`.
 *
 * @param summary - Container from the list endpoint, if any.
 * @param details - Container from inspect, if available (preferred).
 * @returns The classification.
 */
export function classifyContainer(
	summary: ContainerSummary | undefined,
	details?: ContainerDetails | null,
): ContainerClassification {
	if (summary === undefined && (details === undefined || details === null)) {
		return { state: "stopped", health: "none", active: false };
	}
	const dockerState = details?.state ?? summary?.state ?? "exited";
	const health = details?.health ?? summary?.health ?? "none";
	const containerId = details?.id ?? summary?.id;
	const base = {
		health,
		...(containerId !== undefined && { containerId }),
	};
	const error = details?.error ?? "";
	if (
		error !== "" &&
		PORT_IN_USE_PATTERN.test(error) &&
		dockerState !== "running"
	) {
		return {
			...base,
			state: "port-conflict",
			problem: { code: "PORT_CONFLICT", message: error },
			active: false,
		};
	}
	switch (dockerState) {
		case "running": {
			const startedAt = details?.startedAt;
			const running = {
				...base,
				...(startedAt !== undefined && { startedAt }),
				active: true,
			};
			if (health === "starting") return { ...running, state: "starting" };
			if (health === "unhealthy") {
				return {
					...running,
					state: "error",
					problem: {
						code: "UNKNOWN",
						message: "The container is running but its healthcheck fails.",
					},
				};
			}
			return { ...running, state: "running" };
		}
		case "created":
		case "restarting":
			return { ...base, state: "starting", active: true };
		case "dead":
			return {
				...base,
				state: "error",
				problem: {
					code: "UNKNOWN",
					message: error || "The container is dead; remove and start it again.",
				},
				active: false,
			};
		case "exited": {
			const code = details?.exitCode;
			if (code === undefined || STOP_EXIT_CODES.has(code)) {
				return { ...base, state: "stopped", active: false };
			}
			return {
				...base,
				state: "error",
				problem: {
					code: "UNKNOWN",
					message: error || `The container exited with code ${code}.`,
				},
				active: false,
			};
		}
		default:
			return { ...base, state: "stopped", active: false };
	}
}

/**
 * @param port - The busy host port.
 * @param suggestedPort - Free port for the fix, if one was found.
 * @returns The problem shown with the `port-conflict` state.
 */
export function portConflictProblem(
	port: number,
	suggestedPort: number | undefined,
): ServiceProblem {
	return {
		code: "PORT_CONFLICT",
		message: `Port ${port} is already in use by another process on this machine, so the container could not bind.`,
		...(suggestedPort !== undefined && { suggestedPort }),
	};
}

/**
 * @param container - A container of the project.
 * @returns Its service instance name from the LocaInfra labels.
 */
function instanceOf(container: ContainerSummary): string | undefined {
	return container.labels[LABEL_INSTANCE] ?? container.labels[LABEL_SERVICE];
}

/**
 * Joins a resolved project with its containers: one {@link ServiceStatus}
 * per service in stack file order. A service without an active container
 * whose pinned port is busy is `port-conflict`, with a suggested free port.
 *
 * @param deps - Container list, inspect and port probe.
 * @param view - The resolved project.
 * @param order - Instance names in stack file order.
 * @returns The project status, or `DOCKER_UNREACHABLE` when containers cannot be listed.
 */
export async function collectProjectStatus(
	deps: ContainerViewDeps,
	view: ProjectView,
	order: readonly string[],
): Promise<Result<ProjectStatus>> {
	const { resolved } = view;
	let containers: ContainerSummary[];
	try {
		containers = await deps.containers.list({
			labels: { [LABEL_STACK]: resolved.name },
		});
	} catch (cause) {
		return err(
			new OpError("DOCKER_UNREACHABLE", "Docker is not reachable", {
				cause,
				details: {
					fix: "Start Docker Desktop (or your Docker daemon) and run `locainfra doctor`.",
				},
			}),
		);
	}
	const byName = new Map(resolved.services.map((s) => [s.name, s]));
	const services: ServiceStatus[] = [];
	for (const name of order) {
		const service = byName.get(name);
		if (service === undefined) continue;
		const container = containers.find(
			(c) => instanceOf(c) === service.name || c.name === service.containerName,
		);
		services.push(await serviceStatus(deps, view, service, container));
	}
	return ok({ project: resolved.name, network: resolved.network, services });
}

async function serviceStatus(
	deps: ContainerViewDeps,
	view: ProjectView,
	service: ResolvedService,
	container: ContainerSummary | undefined,
): Promise<ServiceStatus> {
	let details: ContainerDetails | null = null;
	if (container !== undefined) {
		try {
			details = await deps.inspector.inspect(container.id);
		} catch {
			details = null;
		}
	}
	let classified = classifyContainer(container, details);
	if (
		!classified.active &&
		classified.state !== "error" &&
		service.hostPort !== UNPROVISIONED_PORT
	) {
		const busy =
			classified.state === "port-conflict" ||
			!(await isFree(deps, service.hostPort));
		if (busy) {
			const suggested = await suggestFreePort(
				deps.probe,
				view.state,
				service.definition,
				[service.hostPort],
			);
			classified = {
				...classified,
				state: "port-conflict",
				problem: portConflictProblem(service.hostPort, suggested),
			};
		}
	}
	return {
		name: service.name,
		type: service.type,
		version: service.version,
		image: service.image,
		hostPort: service.hostPort,
		containerPort: service.containerPort,
		containerName: service.containerName,
		...(classified.containerId !== undefined && {
			containerId: classified.containerId,
		}),
		persist: service.persist,
		state: classified.state,
		health: classified.health,
		...(classified.startedAt !== undefined && {
			startedAt: classified.startedAt,
		}),
		...(classified.problem !== undefined && { problem: classified.problem }),
	};
}

async function isFree(deps: ContainerViewDeps, port: number): Promise<boolean> {
	try {
		return await deps.probe.isFree(port);
	} catch {
		return true;
	}
}
