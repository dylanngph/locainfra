import type { StateFile } from "../../ports/state.port";

/** Who holds a reserved host port. */
export interface PortOwner {
	/** Stack name. */
	readonly stack: string;
	/** Service id. */
	readonly service: string;
}

/**
 * Collects the host ports pinned in state by every stack except `stackName`.
 *
 * @param state - Persisted state.
 * @param stackName - Stack being allocated (its own pins are excluded).
 * @returns Port → owner.
 */
export function portsReservedByOtherStacks(
	state: StateFile,
	stackName: string,
): Map<number, PortOwner> {
	const reserved = new Map<number, PortOwner>();
	for (const [stack, entry] of Object.entries(state.stacks)) {
		if (stack === stackName) continue;
		for (const [service, port] of Object.entries(entry.ports)) {
			if (!reserved.has(port)) reserved.set(port, { stack, service });
		}
	}
	return reserved;
}

/**
 * Enumerates an inclusive port range in ascending order.
 *
 * @param range - `[low, high]` (swapped when reversed).
 * @returns Every port in the range.
 */
export function portsInRange(range: readonly [number, number]): number[] {
	const low = Math.min(range[0], range[1]);
	const high = Math.max(range[0], range[1]);
	const ports: number[] = [];
	for (let port = low; port <= high; port++) ports.push(port);
	return ports;
}
