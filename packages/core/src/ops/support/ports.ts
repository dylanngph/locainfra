import type { ServiceDefinition } from "../../catalog/catalog.model";
import type { PortProbe } from "../../ports/files.port";
import type { StateFile } from "../../ports/state.port";
import { portsInRange } from "../../resolve/ports/ranges";
import { OpError } from "../../shared/op-error";

/** Most ports probed while looking for a suggestion. */
export const MAX_SUGGESTION_PROBES = 64;

/**
 * Finds a free host port to suggest in a "Use port N" fix: the lowest port of
 * the definition's range that no stack has pinned, is not the canonical
 * default (never auto-picked, like the allocator), is not in `exclude`, and
 * is free on 127.0.0.1.
 *
 * @param probe - Host port probe.
 * @param state - Persisted state (every stack's pins are skipped).
 * @param definition - Catalog definition (port range).
 * @param exclude - Ports never suggested (e.g. the busy one).
 * @returns A free port, or `undefined` when none is found within
 *   {@link MAX_SUGGESTION_PROBES} probes.
 */
export async function suggestFreePort(
	probe: PortProbe,
	state: StateFile,
	definition: ServiceDefinition,
	exclude: Iterable<number> = [],
): Promise<number | undefined> {
	const skip = new Set(exclude);
	skip.add(definition.port.default);
	for (const stack of Object.values(state.stacks)) {
		for (const port of Object.values(stack.ports)) skip.add(port);
	}
	let probes = 0;
	for (const port of portsInRange(definition.port.range)) {
		if (skip.has(port)) continue;
		if (probes++ >= MAX_SUGGESTION_PROBES) return undefined;
		try {
			if (await probe.isFree(port)) return port;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Adds `suggestedPort` (and a matching fix hint) to a `PORT_CONFLICT` about
 * one service, so the dashboard can offer "Use port N". Other errors are
 * returned unchanged.
 *
 * @param error - Error from provisioning.
 * @param probe - Host port probe.
 * @param state - Persisted state.
 * @param definitionOf - Looks up the definition of a service instance.
 * @returns The error, enriched when possible.
 */
export async function withPortSuggestion(
	error: OpError,
	probe: PortProbe,
	state: StateFile,
	definitionOf: (service: string) => ServiceDefinition | undefined,
): Promise<OpError> {
	if (error.code !== "PORT_CONFLICT") return error;
	const service = error.details.service;
	if (typeof service !== "string") return error;
	const definition = definitionOf(service);
	if (definition === undefined) return error;
	const busy = error.details.port;
	const suggestedPort = await suggestFreePort(
		probe,
		state,
		definition,
		typeof busy === "number" ? [busy] : [],
	);
	if (suggestedPort === undefined) return error;
	return new OpError(error.code, error.message, {
		cause: error,
		details: {
			...error.details,
			suggestedPort,
			fix: `Use port ${suggestedPort} for ${service} (or free the busy port).`,
		},
	});
}
