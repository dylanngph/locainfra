import { CreateSnapshotRequest, Snapshot } from "@locainfra/core";
import { t } from "elysia";

/** `POST /api/projects/:project/services/:name/snapshots` body. */
export const CreateSnapshotBody = CreateSnapshotRequest;
/** `POST …/snapshots` body. */
export type CreateSnapshotBody = typeof CreateSnapshotBody.static;

/** Reference models of the snapshots controller, registered under `Snapshots.`. */
export const SnapshotsModel = {
	list: t.Array(Snapshot, { description: "Newest first" }),
	snapshot: Snapshot,
	create: CreateSnapshotBody,
};
