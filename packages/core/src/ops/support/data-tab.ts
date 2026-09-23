import type {
	ServiceData,
	ServiceDefinition,
} from "../../catalog/catalog.model";
import { OpError } from "../../shared/op-error";
import { err, ok } from "../../shared/result";
import type { RunningServiceCheck } from "./running-service";

/** A `data` block of a definition that has a Data tab. */
export type EnabledServiceData = ServiceData & {
	readonly kind: "sql" | "redis";
};

/**
 * @param definition - Catalog definition.
 * @returns Its `data` block when the Data tab is enabled (`sql` / `redis`).
 */
export function enabledData(
	definition: ServiceDefinition,
): EnabledServiceData | undefined {
	const data = definition.data;
	if (data === undefined || data.kind === "none") return undefined;
	return data as EnabledServiceData;
}

/**
 * {@link RunningServiceCheck} of the Data tab ops: the definition must have
 * one (`INVALID_INPUT` otherwise); yields its `data` block.
 */
export const DATA_TAB_CHECK: RunningServiceCheck<EnabledServiceData> = {
	precondition: (definition, _entry, stack) => {
		const data = enabledData(definition);
		if (data !== undefined) return ok(data);
		return err(
			new OpError("INVALID_INPUT", `${definition.name} has no Data tab`, {
				details: {
					project: stack.name,
					type: definition.id,
					fix: `Query ${definition.name} with its own client (see the Connect tab).`,
				},
			}),
		);
	},
	startHint: "Start it to run queries.",
};
