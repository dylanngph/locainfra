import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import type { Progress } from "../shared/progress.model";
import type { Paths } from "./paths.port";

/** Pattern of snapshot ids: URL- and filename-safe (base64url alphabet). */
export const SNAPSHOT_ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

/** Pattern of snapshot display names (Snapshots tab input). */
export const SNAPSHOT_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$";

/** File extension of snapshot archives (gzip-compressed tar). */
export const SNAPSHOT_FILE_EXTENSION = ".tgz";

/**
 * One row of the snapshot index (SQLite `snapshots` table). The archive is a
 * gzip tar of the service's named volume contents, stored at
 * {@link snapshotArchivePath}.
 */
export const SnapshotRecord = Type.Object({
	id: Type.String({ pattern: SNAPSHOT_ID_PATTERN }),
	project: Type.String({ description: "Project (stack) name" }),
	service: Type.String({ description: "Service instance name" }),
	name: Type.String({ pattern: SNAPSHOT_NAME_PATTERN }),
	path: Type.String({ description: "Absolute path of the .tgz archive" }),
	sizeBytes: Type.Integer({ minimum: 0 }),
	createdAt: Type.String({ description: "ISO-8601 creation time" }),
	type: Type.Optional(
		Type.String({
			description:
				"Catalog type when archived (absent on rows older than this field)",
		}),
	),
	version: Type.Optional(
		Type.String({
			description:
				"Service version when archived (absent on rows older than this field)",
		}),
	),
	hasSecrets: Type.Optional(
		Type.Boolean({
			description:
				"A secrets sidecar (snapshotSecretsPath) holds the secrets baked into the volume",
		}),
	),
});
/** One row of the snapshot index. */
export type SnapshotRecord = Static<typeof SnapshotRecord>;

/**
 * @param paths - Resolved paths.
 * @param project - Project name.
 * @param service - Service instance name.
 * @returns `<stateDir>/snapshots/<project>/<service>`.
 */
export function snapshotsDir(
	paths: Paths,
	project: string,
	service: string,
): string {
	return join(paths.stateDir, "snapshots", project, service);
}

/**
 * @param paths - Resolved paths.
 * @param project - Project name.
 * @param service - Service instance name.
 * @param id - Snapshot id (must match {@link SNAPSHOT_ID_PATTERN}).
 * @returns `<stateDir>/snapshots/<project>/<service>/<id>.tgz`.
 */
export function snapshotArchivePath(
	paths: Paths,
	project: string,
	service: string,
	id: string,
): string {
	return join(
		snapshotsDir(paths, project, service),
		`${id}${SNAPSHOT_FILE_EXTENSION}`,
	);
}

/** File extension of a snapshot's secrets sidecar. */
export const SNAPSHOT_SECRETS_EXTENSION = ".secrets.json";

/**
 * @param archivePath - A snapshot archive, `<dir>/<id>.tgz` ({@link snapshotArchivePath}).
 * @returns Its secrets sidecar, `<dir>/<id>.secrets.json`: the values (JSON
 *   object, catalog secret name → value, mode 0600) of the secrets baked into
 *   the volume when it was archived.
 */
export function snapshotSecretsPath(archivePath: string): string {
	const base = archivePath.endsWith(SNAPSHOT_FILE_EXTENSION)
		? archivePath.slice(0, -SNAPSHOT_FILE_EXTENSION.length)
		: archivePath;
	return `${base}${SNAPSHOT_SECRETS_EXTENSION}`;
}

/**
 * Archives and restores the contents of a Docker named volume with a
 * throw-away helper container (`docker run --rm`, e.g.
 * `-v <vol>:/from:ro -v <dir>:/to alpine tar czf /to/<file> -C /from .`).
 * Callers stop the service first: a tar of a live database volume is
 * inconsistent. Every stream ends with exactly one `done` or `error` event
 * (like `LifecycleRunner`), and no helper container outlives it.
 */
export interface VolumeArchiver {
	/**
	 * Writes a gzip tar of the volume's contents to `destPath` (its folder is
	 * created when missing). A failed or aborted run leaves no partial file.
	 *
	 * @param volume - Docker volume name (`li-<project>-<service>-<vol>`).
	 * @param destPath - Absolute path of the archive to create.
	 * @param signal - Aborts the run (the helper container is removed).
	 */
	archive(
		volume: string,
		destPath: string,
		signal: AbortSignal,
	): AsyncIterable<Progress>;
	/**
	 * Replaces the volume's contents with the archive's. The archive is
	 * extracted in full before the old contents are deleted, so a corrupt
	 * archive, or one deleted while the restore runs, fails with the volume
	 * unchanged (never empty).
	 *
	 * @param volume - Docker volume name.
	 * @param srcPath - Absolute path of an archive written by {@link VolumeArchiver.archive}.
	 * @param signal - Aborts the run (the helper container is removed).
	 */
	restore(
		volume: string,
		srcPath: string,
		signal: AbortSignal,
	): AsyncIterable<Progress>;
	/**
	 * @param path - Absolute archive path.
	 * @returns Its size in bytes.
	 */
	sizeOf(path: string): Promise<number>;
	/**
	 * Deletes a snapshot file (an archive or its secrets sidecar); a missing
	 * file is not an error.
	 *
	 * @param path - Absolute file path.
	 */
	removeArchive(path: string): Promise<void>;
}

/** Snapshot index (engines: the SQLite `snapshots` table). */
export interface SnapshotIndex {
	/**
	 * @param project - Project name.
	 * @param service - Service instance name.
	 * @returns The service's snapshots, newest first.
	 */
	list(project: string, service: string): Promise<SnapshotRecord[]>;
	/**
	 * @param id - Snapshot id.
	 * @returns The row, or `null` when absent.
	 */
	get(id: string): Promise<SnapshotRecord | null>;
	/**
	 * Adds a row (its `id` must be new).
	 *
	 * @param record - Row to insert.
	 */
	insert(record: SnapshotRecord): Promise<void>;
	/**
	 * @param id - Snapshot id.
	 * @returns Whether a row was deleted.
	 */
	delete(id: string): Promise<boolean>;
}
