import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { seedLabel } from "@/features/config/lib/seed-path";
import { dataObjectsQuery } from "@/features/data/api/data.api";
import { invalidationFor } from "@/features/projects/api/project-invalidation";
import { errorMessage } from "@/shared/lib/api-error";
import { trackOp } from "@/shared/lib/track-op";
import {
	createSnapshot,
	deleteSnapshot,
	restoreSnapshot,
	type Snapshot,
	seedService,
	snapshotsKey,
} from "../api/snapshots.api";

/** Snapshot and seed actions of one service; each resolves `true` on success. */
export interface SnapshotActions {
	/** Create a snapshot (`name` empty: the server picks `snap-<n>`). */
	create(name: string): Promise<boolean>;
	/** Replace the service's data with a snapshot. */
	restore(snapshot: Snapshot): Promise<boolean>;
	/** Delete a snapshot archive (no op: answers directly). */
	remove(snapshot: Snapshot): Promise<boolean>;
	/** Re-apply the service's seed file. */
	seed(path: string): Promise<boolean>;
}

/**
 * Snapshot actions of a service: the `202` ones are followed in a progress
 * toast (`GET /api/ops/:opId/events`); when they settle the snapshot list
 * and the service's state are refetched once, and after a restore or a seed
 * also the Data tab's object list. Nothing polls.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns The actions.
 */
export function useSnapshotActions(
	project: string,
	name: string,
): SnapshotActions {
	const queryClient = useQueryClient();
	return useMemo(() => {
		const invalidate = [
			{ queryKey: snapshotsKey(project, name), exact: true },
			...invalidationFor({ kind: "service-state", project, service: name }),
		];
		// Restore and seed change the data itself: the Data tab's object list
		// (tables, key patterns) is refetched too.
		const dataChanged = [
			...invalidate,
			{ queryKey: dataObjectsQuery(project, name).queryKey, exact: true },
		];
		const follow = async (
			title: string,
			start: () => Promise<string>,
			keys: typeof invalidate = invalidate,
		) => {
			try {
				const opId = await start();
				const result = await trackOp(opId, {
					title,
					queryClient,
					invalidate: keys,
				});
				return result.kind === "done";
			} catch (error) {
				toast.error(errorMessage(error));
				return false;
			}
		};
		return {
			create: (snapshotName) =>
				follow(
					snapshotName
						? `Creating snapshot “${snapshotName}” of ${name}…`
						: `Creating a snapshot of ${name}…`,
					() => createSnapshot(project, name, snapshotName || undefined),
				),
			restore: (snapshot) =>
				follow(
					`Restoring ${name} to “${snapshot.name}”…`,
					() => restoreSnapshot(project, name, snapshot.id),
					dataChanged,
				),
			seed: (path) =>
				follow(
					`Seeding ${name} from ${seedLabel(path)}…`,
					() => seedService(project, name),
					dataChanged,
				),
			remove: async (snapshot) => {
				try {
					await deleteSnapshot(project, name, snapshot.id);
					toast(`Deleted “${snapshot.name}”`);
					await queryClient.invalidateQueries({
						queryKey: snapshotsKey(project, name),
						exact: true,
					});
					return true;
				} catch (error) {
					toast.error(errorMessage(error));
					return false;
				}
			},
		};
	}, [project, name, queryClient]);
}
