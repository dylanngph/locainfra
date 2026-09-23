import type { Clock, PortProbe } from "../../ports/files.port";
import type {
	StateFile,
	StateReader,
	StateWriter,
} from "../../ports/state.port";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import { GLOBAL_STACK_NAME, type Stack } from "../../stack/stack.model";
import type { PlannedService } from "../plan";
import {
	type PortOwner,
	portsInRange,
	portsReservedByOtherStacks,
} from "./ranges";

/** Ports needed by {@link allocatePorts}. */
export interface PortAllocatorDeps {
	/** Host port probe (127.0.0.1). */
	readonly probe: PortProbe;
	/** Persisted state; allocations are pinned here. */
	readonly state: StateReader & StateWriter;
	/** Time source for a new stack's `createdAt`. */
	readonly clock: Clock;
}

/** Input of {@link allocatePorts}. */
export interface PortAllocatorInput {
	/** The stack being provisioned. */
	readonly stack: Stack;
	/** Its services (from `planStack`). */
	readonly services: readonly PlannedService[];
}

/** Attempts before a repeatedly raced allocation gives up with `PORT_CONFLICT`. */
export const MAX_PORT_ALLOCATION_ATTEMPTS = 5;

/**
 * Picks and pins a host port for every service of a stack.
 *
 * - A fixed `port:` (and, for the global stack, the definition's canonical
 *   `port.default`) is used as is. It is probed unless it is already this
 *   service's pinned port (the stack may be running), and it must not be
 *   pinned by another stack or claimed twice in this stack.
 * - `port: auto` (or no port) in a project stack keeps the pinned port from
 *   state when there is one; otherwise it takes the lowest port in
 *   `port.range` that is free on 127.0.0.1, not pinned by any stack, and not
 *   the definition's canonical default (kept for the global stack).
 *
 * The result replaces the stack's `ports` in state (services no longer in
 * the stack release their pins).
 *
 * Concurrency: probing is async, so the choice is made outside the state
 * lock and validated inside it (optimistic concurrency). The `state.update`
 * mutator re-checks that no other stack pinned a chosen port and that this
 * stack's own pins did not change since the read; if either happened (a
 * concurrent `up` from another terminal or the dashboard), nothing is pinned
 * and the allocation is retried from fresh state, up to
 * {@link MAX_PORT_ALLOCATION_ATTEMPTS} times.
 *
 * @param deps - Probe, state and clock.
 * @param input - Stack and its planned services.
 * @returns Service id → host port, or `PORT_CONFLICT` / `IO`.
 */
export async function allocatePorts(
	deps: PortAllocatorDeps,
	input: PortAllocatorInput,
): Promise<Result<Record<string, number>>> {
	const name = input.stack.name;
	try {
		for (let attempt = 1; attempt <= MAX_PORT_ALLOCATION_ATTEMPTS; attempt++) {
			const snapshot = await deps.state.read();
			const result = await allocate(deps, input, snapshot);
			if (!result.ok) return result;
			const ports = result.value;
			let raced = false;
			await deps.state.update((state) => {
				if (!isStillValid(state, snapshot, name, ports)) {
					raced = true;
					return state;
				}
				return {
					...state,
					stacks: {
						...state.stacks,
						[name]: {
							ports,
							createdAt:
								state.stacks[name]?.createdAt ?? deps.clock.now().toISOString(),
						},
					},
				};
			});
			if (!raced) return ok(ports);
		}
		return err(
			new OpError(
				"PORT_CONFLICT",
				`Host ports kept changing while allocating ports for "${name}"`,
				{
					details: {
						stack: name,
						attempts: MAX_PORT_ALLOCATION_ATTEMPTS,
						fix: "Another LocaInfra process is starting stacks at the same time; run the command again.",
					},
				},
			),
		);
	} catch (cause) {
		return err(
			new OpError("IO", "Could not allocate host ports", {
				cause,
				details: { stack: name },
			}),
		);
	}
}

/**
 * Whether an allocation computed from `snapshot` can still be pinned on
 * `current`: no chosen port is now pinned by another stack, and this stack's
 * own pins are unchanged.
 */
function isStillValid(
	current: StateFile,
	snapshot: StateFile,
	name: string,
	ports: Readonly<Record<string, number>>,
): boolean {
	const reserved = portsReservedByOtherStacks(current, name);
	if (Object.values(ports).some((port) => reserved.has(port))) return false;
	return samePins(current.stacks[name]?.ports, snapshot.stacks[name]?.ports);
}

function samePins(
	a: Readonly<Record<string, number>> | undefined,
	b: Readonly<Record<string, number>> | undefined,
): boolean {
	const left = Object.entries(a ?? {});
	const right = b ?? {};
	return (
		left.length === Object.keys(right).length &&
		left.every(([service, port]) => right[service] === port)
	);
}

async function allocate(
	deps: PortAllocatorDeps,
	{ stack, services }: PortAllocatorInput,
	state: StateFile,
): Promise<Result<Record<string, number>>> {
	const pinned = state.stacks[stack.name]?.ports ?? {};
	const reserved = portsReservedByOtherStacks(state, stack.name);
	const claimed = new Map<number, string>();
	const ports: Record<string, number> = {};
	const isGlobal = stack.kind === "global";

	const fixedPort = (service: PlannedService): number | undefined => {
		const requested = service.entry.port;
		if (typeof requested === "number") return requested;
		return isGlobal ? service.definition.port.default : undefined;
	};

	for (const service of services) {
		const port = fixedPort(service);
		if (port === undefined) continue;
		const owner = claimed.get(port);
		if (owner !== undefined) {
			return err(
				conflict(stack, service.id, port, {
					stack: stack.name,
					service: owner,
				}),
			);
		}
		const holder = reserved.get(port);
		if (holder) return err(conflict(stack, service.id, port, holder));
		if (pinned[service.id] !== port && !(await deps.probe.isFree(port))) {
			return err(conflict(stack, service.id, port));
		}
		claimed.set(port, service.id);
		ports[service.id] = port;
	}

	const autoServices = services.filter((s) => fixedPort(s) === undefined);
	const keptPins = new Set<number>();
	for (const service of autoServices) {
		const pin = pinned[service.id];
		if (pin !== undefined && !claimed.has(pin) && !reserved.has(pin)) {
			keptPins.add(pin);
		}
	}

	for (const service of autoServices) {
		const pin = pinned[service.id];
		if (pin !== undefined && keptPins.has(pin) && !claimed.has(pin)) {
			claimed.set(pin, service.id);
			ports[service.id] = pin;
			continue;
		}
		const { range, default: canonical } = service.definition.port;
		let picked: number | undefined;
		for (const candidate of portsInRange(range)) {
			if (
				candidate === canonical ||
				claimed.has(candidate) ||
				keptPins.has(candidate) ||
				reserved.has(candidate)
			) {
				continue;
			}
			if (await deps.probe.isFree(candidate)) {
				picked = candidate;
				break;
			}
		}
		if (picked === undefined) {
			return err(
				new OpError(
					"PORT_CONFLICT",
					`No free host port for "${service.id}" in ${range[0]}-${range[1]}`,
					{
						details: {
							stack: stack.name,
							service: service.id,
							range: [range[0], range[1]],
							fix: `Free a port in ${range[0]}-${range[1]} or set a fixed "port:" for ${service.id} in ${stack.filePath}.`,
						},
					},
				),
			);
		}
		claimed.set(picked, service.id);
		ports[service.id] = picked;
	}

	return ok(ports);
}

function conflict(
	stack: Stack,
	service: string,
	port: number,
	owner?: PortOwner,
): OpError {
	const by = owner
		? ` (reserved by ${owner.stack === stack.name ? "" : `stack "${owner.stack}", `}service "${owner.service}")`
		: "";
	const fix =
		stack.kind === "global" || stack.name === GLOBAL_STACK_NAME
			? `Stop whatever uses 127.0.0.1:${port}, or set a different "port:" for ${service} in ${stack.filePath}.`
			: `Stop whatever uses 127.0.0.1:${port}, set a different "port:" for ${service}, or use "port: auto" in ${stack.filePath}.`;
	return new OpError(
		"PORT_CONFLICT",
		`Port ${port} for "${service}" is already in use${by}`,
		{
			details: {
				stack: stack.name,
				service,
				port,
				...(owner ? { reservedBy: { ...owner } } : {}),
				fix,
			},
		},
	);
}
