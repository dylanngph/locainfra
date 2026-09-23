import { ioErrorFrom } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadProject } from "./load-project.op";
import type { ListSnapshots } from "./ops.contract";
import { findService } from "./support/service-input";
import { toSnapshot } from "./support/snapshots";

/**
 * The service's snapshots, newest first. `PROJECT_NOT_FOUND`,
 * `SERVICE_NOT_FOUND`, or `IO` when the index cannot be read.
 */
export const listSnapshots: ListSnapshots = async (deps, input) => {
	const loaded = await loadProject(deps, input);
	if (!loaded.ok) return loaded;
	const entry = findService(loaded.value, input.name);
	if (!entry.ok) return entry;
	try {
		const rows = await deps.snapshots.list(loaded.value.name, input.name);
		return ok(rows.map(toSnapshot));
	} catch (cause) {
		return err(ioErrorFrom("Could not read the snapshot index", cause));
	}
};
