import type { ServiceDefinition } from "../catalog/catalog.model";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import type { Stack, StackServiceEntry } from "../stack/stack.model";

/** A stack service instance paired with its catalog definition. */
export interface PlannedService {
	/** Instance name (key in the stack file's `services`). */
	readonly name: string;
	/** The stack file entry (user overrides). */
	readonly entry: StackServiceEntry;
	/** The catalog definition (`entry.type`). */
	readonly definition: ServiceDefinition;
	/**
	 * The definition's `dependsOn`, mapped catalog id → instance name (the
	 * entry's `uses`, else the first instance of that type in file order).
	 */
	readonly dependencies: Readonly<Record<string, string>>;
}

/**
 * Pairs every stack service instance with its catalog definition (by
 * `type`), binds each `dependsOn` catalog id to an instance, and orders them
 * so each instance comes after its dependencies (stable: ties keep stack file
 * order).
 *
 * @param stack - The stack.
 * @param definitions - The merged catalog.
 * @returns Services in dependency order, or `INVALID_STACK` for an unknown
 *   type, a dependency with no instance of its type (or a `uses` naming a
 *   service of another type), or a cycle.
 */
export function planStack(
	stack: Stack,
	definitions: readonly ServiceDefinition[],
): Result<PlannedService[]> {
	const byId = new Map(definitions.map((d) => [d.id, d]));
	const entries = Object.entries(stack.file.services);
	const planned = new Map<string, PlannedService>();

	for (const [name, entry] of entries) {
		const definition = byId.get(entry.type);
		if (!definition) {
			return err(
				new OpError(
					"INVALID_STACK",
					`Unknown service type "${entry.type}" for "${name}" in stack "${stack.name}"`,
					{
						details: {
							service: name,
							type: entry.type,
							filePath: stack.filePath,
							fix: "Use a type from the catalog or remove the entry.",
						},
					},
				),
			);
		}
		const dependencies: Record<string, string> = {};
		for (const dep of definition.dependsOn ?? []) {
			const chosen = entry.uses?.[dep];
			const candidates = entries
				.filter(([other, e]) => other !== name && e.type === dep)
				.map(([other]) => other);
			const target =
				chosen === undefined
					? candidates[0]
					: candidates.includes(chosen)
						? chosen
						: undefined;
			if (target === undefined) {
				const reason =
					chosen === undefined
						? `needs a ${dep} service, and stack "${stack.name}" has none`
						: `uses.${dep} names "${chosen}", which is not a ${dep} service of stack "${stack.name}"`;
				return err(
					new OpError("INVALID_STACK", `Service "${name}" ${reason}`, {
						details: {
							service: name,
							dependency: dep,
							filePath: stack.filePath,
							fix:
								candidates.length > 0
									? `Set services.${name}.uses.${dep} to one of: ${candidates.join(", ")}.`
									: `Add a ${dep} service to the stack.`,
						},
					}),
				);
			}
			dependencies[dep] = target;
		}
		planned.set(name, { name, entry, definition, dependencies });
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
			Object.values(service.dependencies).every((dep) => done.has(dep)),
		);
		if (index === -1) {
			const cycle = pending.map((service) => service.name);
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
			done.add(next.name);
		}
	}
	return ok(ordered);
}
