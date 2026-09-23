import { ioErrorFrom } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadProject } from "./load-project.op";
import type { DeleteSnapshot } from "./ops.contract";
import {
	deleteSnapshotFiles,
	findSnapshot,
	toSnapshot,
} from "./support/snapshots";

/**
 * Deletes a snapshot's archive file and secrets sidecar, then its index
 * row, and returns it.
 * Touches no container. `PROJECT_NOT_FOUND`; `SNAPSHOT_NOT_FOUND` when the
 * id is unknown or belongs to another service; `IO`. The service itself
 * need not exist any more, so snapshots of a removed service can be cleaned
 * up.
 */
export const deleteSnapshot: DeleteSnapshot = async (deps, input) => {
	const loaded = await loadProject(deps, input);
	if (!loaded.ok) return loaded;
	const found = await findSnapshot(deps.snapshots, input);
	if (!found.ok) return found;
	try {
		await deleteSnapshotFiles(deps, found.value);
	} catch (cause) {
		return err(
			ioErrorFrom(`Could not delete snapshot "${found.value.name}"`, cause),
		);
	}
	return ok(toSnapshot(found.value));
};
