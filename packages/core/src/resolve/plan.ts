import type { ServiceDefinition } from "../catalog/catalog.model";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import type { Stack, StackServiceEntry } from "../stack/stack.model";

/** A stack service paired with its catalog definition. */
export interface PlannedService {
	/** Service key in the stack (equals the catalog id). */
	readonly id: string;
	/** The stack file entry (user overrides). */
	readonly entry: StackServiceEntry;
	/** The catalog definition. */
	readonly definition: ServiceDefinition;
}

/**
 * Pairs every stack service with its catalog definition and orders them so
 * each service comes after everything in its `dependsOn` (stable: ties keep
 * stack file order).
 *
 * @param stack - The stack.
 * @param definitions - The merged catalog.
 * @returns Services in dependency order, or `INVALID_STACK` for an unknown
 *   service, a dependency missing from the stack, or a dependency cycle.
 */
export function planStack(
	stack: Stack,
	definitions: readonly ServiceDefinition[],
): Result<PlannedService[]> {
	const byId = new Map(definitions.map((d) => [d.id, d]));
	const planned = new Map<string, PlannedService>();

	for (const [id, entry] of Object.entries(stack.file.services)) {
		const definition = byId.get(id);
		if (!definition) {
			return err(
				new OpError(
					"INVALID_STACK",
					`Unknown service "${id}" in stack "${stack.name}"`,
					{
						details: {
							service: id,
							filePath: stack.filePath,
							fix: "Use a service id from the catalog (Explore view) or remove the entry.",
						},
					},
				),
			);
		}
		planned.set(id, { id, entry, definition });
	}

	for (const service of planned.values()) {
		for (const dep of service.definition.dependsOn ?? []) {
			if (!planned.has(dep)) {
				return err(
					new OpError(
						"INVALID_STACK",
						`Service "${service.id}" depends on "${dep}", which is not in stack "${stack.name}"`,
						{
							details: {
								service: service.id,
								dependency: dep,
								fix: `Add "${dep}" to the stack.`,
							},
						},
					),
				);
			}
		}
	}

	return topologicalOrder(planned);
}

function topologicalOrder(
	planned: ReadonlyMap<string, PlannedService>,
): Result<PlannedService[]> {
	const ordered: PlannedService[] = [];
	const done = new Set<string>();
	const pending = [...planned.values()];

	while (pending.length > 0) {
		const index = pending.findIndex((service) =>
			(service.definition.dependsOn ?? []).every((dep) => done.has(dep)),
		);
		if (index === -1) {
			const cycle = pending.map((service) => service.id);
			return err(
				new OpError(
					"INVALID_STACK",
					`Dependency cycle between services: ${cycle.join(", ")}`,
					{
						details: {
							services: cycle,
							fix: "Remove one of the dependsOn references so the services form no cycle.",
						},
					},
				),
			);
		}
		const [next] = pending.splice(index, 1);
		if (next) {
			ordered.push(next);
			done.add(next.id);
		}
	}
	return ok(ordered);
}
