import { queryOptions } from "@tanstack/react-query";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { api, unwrap } from "@/shared/lib/api";

const service = (project: string, name: string) =>
	api.api.projects({ project }).services({ name });

/**
 * `GET …/services/:name/snapshots`, newest first.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns The snapshots.
 */
export const fetchSnapshots = (project: string, name: string) =>
	unwrap(service(project, name).snapshots.get());

/** One snapshot: `{ id, service, name, sizeBytes, createdAt }`. */
export type { Snapshot } from "@locainfra/server";

/**
 * Key of a service's snapshot list (under the service key, so Refresh
 * refetches it).
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns The query key.
 */
export const snapshotsKey = (project: string, name: string) =>
	[...PROJECTS_KEY, "detail", project, "services", name, "snapshots"] as const;

/**
 * Query of a service's snapshots.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns Query options.
 */
export const snapshotsQuery = (project: string, name: string) =>
	queryOptions({
		queryKey: snapshotsKey(project, name),
		queryFn: () => fetchSnapshots(project, name),
	});

/**
 * `POST …/snapshots`: stops the service if needed, archives its volume,
 * starts it again.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param snapshotName - Display name; the server picks `snap-<n>` when omitted.
 * @returns The op id.
 */
export const createSnapshot = async (
	project: string,
	name: string,
	snapshotName?: string,
) =>
	(
		await unwrap(
			service(project, name).snapshots.post(
				snapshotName ? { name: snapshotName } : {},
			),
		)
	).opId;

/**
 * `POST …/snapshots/:id/restore`: replaces the service's data with the snapshot.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param id - Snapshot id.
 * @returns The op id.
 */
export const restoreSnapshot = async (
	project: string,
	name: string,
	id: string,
) =>
	(await unwrap(service(project, name).snapshots({ id }).restore.post())).opId;

/**
 * `DELETE …/snapshots/:id`: deletes the archive (no container involved).
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param id - Snapshot id.
 * @returns The deleted snapshot.
 */
export const deleteSnapshot = (project: string, name: string, id: string) =>
	unwrap(service(project, name).snapshots({ id }).delete());

/**
 * `POST …/seed`: re-applies the service's seed file in the running container.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns The op id.
 */
export const seedService = async (project: string, name: string) =>
	(await unwrap(service(project, name).seed.post())).opId;
