import type { ServiceDefinition } from "../../catalog/catalog.model";
import { serviceVolumeName } from "../../paths/layout";
import type { ComposeTarget, LifecycleRunner } from "../../ports/compose.port";
import type { FileStore, SecretGenerator } from "../../ports/files.port";
import {
	SNAPSHOT_ID_PATTERN,
	type SnapshotIndex,
	type SnapshotRecord,
	snapshotSecretsPath,
	type VolumeArchiver,
} from "../../ports/snapshot.port";
import { ioErrorFrom, OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import {
	DEFAULT_PERSIST_MODE,
	type Stack,
	type StackServiceEntry,
} from "../../stack/stack.model";
import { loadProject } from "../load-project.op";
import type { ServiceRef, SnapshotDeps } from "../ops.contract";
import type { Snapshot } from "../ops.model";
import { loadDefinitions } from "./catalog";
import { checkComposeVersion, composeTarget } from "./compose";
import { dockerUnreachable } from "./running-service";
import { findDefinition, findService } from "./service-input";

const SNAPSHOT_ID = new RegExp(SNAPSHOT_ID_PATTERN);

/** Random bytes of a snapshot id: 9 bytes are 12 base64url characters. */
export const SNAPSHOT_ID_BYTES = 9;

/** Attempts at drawing an unused snapshot id. */
const MAX_ID_ATTEMPTS = 5;

/** A service whose data volume can be archived or restored. */
export interface SnapshotTarget {
	/** The project stack. */
	readonly stack: Stack;
	/** The service's stack entry. */
	readonly entry: StackServiceEntry;
	/** Its catalog definition. */
	readonly definition: ServiceDefinition;
	/** Docker volume name, `li-<project>-<service>-<vol>`. */
	readonly volume: string;
	/** Rendered compose project. */
	readonly compose: ComposeTarget;
}

/**
 * @param record - Index row.
 * @returns The API view of a snapshot (no file path, no project).
 */
export function toSnapshot(record: SnapshotRecord): Snapshot {
	return {
		id: record.id,
		service: record.service,
		name: record.name,
		sizeBytes: record.sizeBytes,
		createdAt: record.createdAt,
	};
}

/**
 * @param id - Snapshot id as given by the caller.
 * @param ref - The service it should belong to.
 * @param reason - Extra context, e.g. `its file is gone`.
 * @returns `SNAPSHOT_NOT_FOUND` for it (a malformed id is not echoed).
 */
export function snapshotNotFound(
	id: string,
	ref: ServiceRef,
	reason?: string,
): OpError {
	return new OpError(
		"SNAPSHOT_NOT_FOUND",
		`${ref.name} has no snapshot "${SNAPSHOT_ID.test(id) ? id : "?"}"${reason === undefined ? "" : ` (${reason})`}`,
		{
			details: {
				project: ref.project,
				service: ref.name,
				fix: "Refresh the Snapshots tab: the snapshot may have been deleted.",
			},
		},
	);
}

/**
 * Loads a snapshot row and checks it belongs to the service.
 *
 * @param index - Snapshot index.
 * @param ref - Project, service and snapshot id.
 * @returns The row, `SNAPSHOT_NOT_FOUND` or `IO`.
 */
export async function findSnapshot(
	index: SnapshotIndex,
	ref: ServiceRef & { readonly snapshotId: string },
): Promise<Result<SnapshotRecord>> {
	if (!SNAPSHOT_ID.test(ref.snapshotId)) {
		return err(snapshotNotFound(ref.snapshotId, ref));
	}
	let record: SnapshotRecord | null;
	try {
		record = await index.get(ref.snapshotId);
	} catch (cause) {
		return err(ioErrorFrom("Could not read the snapshot index", cause));
	}
	if (
		record === null ||
		record.project !== ref.project ||
		record.service !== ref.name
	) {
		return err(snapshotNotFound(ref.snapshotId, ref));
	}
	return ok(record);
}

/**
 * Draws a new snapshot id (`gen.generate(9)`, 12 base64url characters) that
 * matches `SNAPSHOT_ID_PATTERN` and is not in the index.
 *
 * @param gen - Random source.
 * @param index - Snapshot index.
 * @returns The id, or `IO`.
 */
export async function newSnapshotId(
	gen: SecretGenerator,
	index: SnapshotIndex,
): Promise<Result<string>> {
	try {
		for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
			const id = gen.generate(SNAPSHOT_ID_BYTES);
			if (SNAPSHOT_ID.test(id) && (await index.get(id)) === null) return ok(id);
		}
	} catch (cause) {
		return err(ioErrorFrom("Could not read the snapshot index", cause));
	}
	return err(new OpError("IO", "Could not draw a unique snapshot id"));
}

/** Ports needed by {@link loadSnapshotTarget}. */
export type SnapshotTargetDeps = Pick<
	SnapshotDeps,
	"state" | "files" | "catalog" | "paths" | "compose"
>;

/**
 * Loads a service whose data volume can be snapshotted or restored:
 * `persist: volume`, exactly one catalog volume, rendered at least once, and
 * a compose version that can stop and start it.
 *
 * @param deps - Project read, catalog, paths and compose.
 * @param ref - Project and service.
 * @returns The target, or `PROJECT_NOT_FOUND` / `SERVICE_NOT_FOUND` /
 *   `INVALID_INPUT` (ephemeral, no or several volumes, never started) /
 *   `INVALID_CATALOG` / `COMPOSE_*`.
 */
export async function loadSnapshotTarget(
	deps: SnapshotTargetDeps,
	ref: ServiceRef,
): Promise<Result<SnapshotTarget>> {
	const loaded = await loadProject(deps, ref);
	if (!loaded.ok) return loaded;
	const stack = loaded.value;
	const entry = findService(stack, ref.name);
	if (!entry.ok) return entry;
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	const definition = findDefinition(definitions.value, entry.value.type);
	if (!definition.ok) return definition;
	const invalid = (message: string, fix: string) =>
		err(
			new OpError("INVALID_INPUT", message, {
				details: { project: stack.name, service: ref.name, fix },
			}),
		);
	if ((entry.value.persist ?? DEFAULT_PERSIST_MODE) === "ephemeral") {
		return invalid(
			`${ref.name} is ephemeral, so it has no data volume to snapshot`,
			"Switch it to persist: volume on the Config page first.",
		);
	}
	const [volume, ...others] = definition.value.volumes;
	if (volume === undefined) {
		return invalid(
			`${definition.value.name} keeps no data in a volume`,
			"Snapshots need a service with a data volume.",
		);
	}
	if (others.length > 0) {
		return invalid(
			`${definition.value.name} has ${definition.value.volumes.length} volumes; snapshots support one`,
			"Back up this service with its own tools.",
		);
	}
	const compose = composeTarget(deps.paths, stack.name);
	let rendered: boolean;
	try {
		rendered = await deps.files.exists(compose.composeFile);
	} catch (cause) {
		return err(ioErrorFrom(`Could not read ${compose.composeFile}`, cause));
	}
	if (!rendered) {
		return invalid(
			`${ref.name} has never been started, so it has no data yet`,
			`Start ${ref.name} first.`,
		);
	}
	const version = await checkComposeVersion(deps.compose);
	if (!version.ok) return version;
	return ok({
		stack,
		entry: entry.value,
		definition: definition.value,
		volume: serviceVolumeName(stack.name, ref.name, volume.name),
		compose,
	});
}

/**
 * @param lifecycle - Compose lifecycle.
 * @param target - The service's compose project.
 * @param name - Service instance name.
 * @returns Whether its container is running (`compose ps`), or `DOCKER_UNREACHABLE`.
 */
export async function isServiceRunning(
	lifecycle: LifecycleRunner,
	target: ComposeTarget,
	name: string,
): Promise<Result<boolean>> {
	try {
		const rows = await lifecycle.ps(target);
		return ok(
			rows.some((row) => row.service === name && row.state === "running"),
		);
	} catch (cause) {
		return err(dockerUnreachable(cause));
	}
}

/**
 * @param definition - Catalog definition.
 * @returns Its secrets marked `bakedIntoVolume` (written into the data volume
 *   on first start, so a snapshot of the volume carries their values).
 */
export function bakedSecretNames(definition: ServiceDefinition): string[] {
	return definition.secrets.filter(
		(key) => definition.secretOptions?.[key]?.bakedIntoVolume === true,
	);
}

/**
 * @param version - A version tag, e.g. `17`, `7.4`, `8.0-alpine`.
 * @returns Its major part (`17`, `7`, `8`).
 */
export function majorVersion(version: string): string {
	return version.split(/[.-]/)[0] ?? version;
}

/**
 * Checks that a snapshot's data fits the service as it is now configured:
 * same catalog type and same major version (a data directory of another
 * engine, or of another major release, would not start or would be
 * silently re-initialised). Rows written before these fields existed pass.
 *
 * @param record - The snapshot row.
 * @param entry - The stack entry of the service it is restored into.
 * @param definition - That entry's catalog definition.
 * @returns `INVALID_INPUT` (`details.reason`: `type-mismatch` /
 *   `version-mismatch`, with a `fix`), or `undefined` when it fits.
 */
export function snapshotMismatch(
	record: SnapshotRecord,
	entry: Pick<StackServiceEntry, "type" | "version">,
	definition: Pick<ServiceDefinition, "name" | "defaultVersion">,
): OpError | undefined {
	const name = record.service;
	const details = (reason: string, fix: string) => ({
		project: record.project,
		service: name,
		snapshot: record.id,
		reason,
		fix,
	});
	if (record.type !== undefined && record.type !== entry.type) {
		return new OpError(
			"INVALID_INPUT",
			`Snapshot “${record.name}” holds ${record.type} data, but ${name} is now ${definition.name}`,
			{
				details: details(
					"type-mismatch",
					"It cannot be restored into this service. Delete it, or re-create the service with its old type to use it.",
				),
			},
		);
	}
	const version = entry.version ?? definition.defaultVersion;
	if (
		record.version !== undefined &&
		majorVersion(record.version) !== majorVersion(version)
	) {
		return new OpError(
			"INVALID_INPUT",
			`Snapshot “${record.name}” was taken on ${definition.name} ${record.version}, but ${name} now runs ${version}`,
			{
				details: details(
					"version-mismatch",
					`Switch ${name} back to version ${record.version} on the Config page, restore, then upgrade with the service's own tools.`,
				),
			},
		);
	}
	return undefined;
}

/**
 * Reads a snapshot's secrets sidecar: the values of the secrets baked into
 * the volume when it was archived. Only keys the definition marks
 * `bakedIntoVolume` are returned.
 *
 * @param files - File access.
 * @param record - The snapshot row.
 * @param definition - The service's catalog definition.
 * @param ref - Project and service (for errors).
 * @returns Catalog secret name → value (`{}` when the row has no sidecar);
 *   `SNAPSHOT_NOT_FOUND` when the sidecar is gone, `IO` when unreadable or
 *   malformed.
 */
export async function readSnapshotSecrets(
	files: FileStore,
	record: SnapshotRecord,
	definition: ServiceDefinition,
	ref: ServiceRef,
): Promise<Result<Record<string, string>>> {
	if (record.hasSecrets !== true) return ok({});
	const path = snapshotSecretsPath(record.path);
	let text: string | null;
	try {
		text = await files.readText(path);
	} catch (cause) {
		return err(ioErrorFrom("Could not read the snapshot's secrets", cause));
	}
	if (text === null) {
		return err(snapshotNotFound(record.id, ref, "its secrets file is gone"));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return err(new OpError("IO", "The snapshot's secrets file is malformed"));
	}
	const baked = new Set(bakedSecretNames(definition));
	const secrets: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			return err(new OpError("IO", "The snapshot's secrets file is malformed"));
		}
		if (baked.has(key)) secrets[key] = value;
	}
	return ok(secrets);
}

/**
 * Deletes a snapshot's archive, its secrets sidecar, then its index row.
 *
 * @param deps - Archiver (file removal) and index.
 * @param record - The snapshot row.
 * @throws When a file or the row cannot be deleted (missing files are fine).
 */
export async function deleteSnapshotFiles(
	deps: {
		readonly archiver: VolumeArchiver;
		readonly snapshots: SnapshotIndex;
	},
	record: SnapshotRecord,
): Promise<void> {
	await deps.archiver.removeArchive(record.path);
	await deps.archiver.removeArchive(snapshotSecretsPath(record.path));
	await deps.snapshots.delete(record.id);
}
