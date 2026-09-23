import type { ServiceDefinition } from "../catalog/catalog.model";
import {
	SNAPSHOT_NAME_PATTERN,
	type SnapshotRecord,
	snapshotArchivePath,
	snapshotSecretsPath,
} from "../ports/snapshot.port";
import { instanceSecretKey } from "../resolve/secrets/generator";
import { ioErrorFrom, OpError } from "../shared/op-error";
import type { Progress } from "../shared/progress.model";
import { subStep } from "../shared/sub-progress";
import type { CreateSnapshot, SnapshotDeps } from "./ops.contract";
import { SECRET_FILE_MODE, UP_WAIT_TIMEOUT_SEC } from "./support/compose";
import { serviceError, serviceStep } from "./support/service-lifecycle";
import {
	bakedSecretNames,
	isServiceRunning,
	loadSnapshotTarget,
	newSnapshotId,
} from "./support/snapshots";

const SNAPSHOT_NAME = new RegExp(SNAPSHOT_NAME_PATTERN);

/**
 * Archives a service's data volume to
 * `<stateDir>/snapshots/<project>/<service>/<id>.tgz` and records it in the
 * index. Steps: "Stopping <name>" (only when it was running: a tar of a live
 * database volume is inconsistent), "Archiving <volume>", "Starting <name>"
 * (only when it was running; also after a failed archive), then `done`
 * "Snapshot “<name>” created". The row records the catalog type and version
 * (restore refuses another type or major version); the values of the
 * secrets baked into the volume (`bakedIntoVolume`) go to a mode-0600
 * sidecar next to the archive (`snapshotSecretsPath`), never to the index.
 *
 * Errors (one `error` event): `INVALID_INPUT` for a bad name, an ephemeral
 * service, a definition without (or with several) volumes, or a service
 * never started; `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`, `COMPOSE_*`,
 * `DOCKER_UNREACHABLE`, `IO`, or the archiver's / compose's error. A failed
 * archive leaves no file and no index row.
 */
export const createSnapshot: CreateSnapshot = async function* (deps, input) {
	const { name } = input;
	const clock = deps.clock;
	const fail = (error: OpError) => serviceError(error, name, clock);

	if (
		input.snapshotName !== undefined &&
		!SNAPSHOT_NAME.test(input.snapshotName)
	) {
		yield fail(
			new OpError(
				"INVALID_INPUT",
				`"${input.snapshotName}" is not a valid snapshot name`,
				{
					details: {
						fix: "Use up to 64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.",
					},
				},
			),
		);
		return;
	}
	const target = await loadSnapshotTarget(deps, input);
	if (!target.ok) {
		yield fail(target.error);
		return;
	}
	const { stack, entry, definition, volume, compose } = target.value;

	let existing: number;
	try {
		existing = (await deps.snapshots.list(stack.name, name)).length;
	} catch (cause) {
		yield fail(ioErrorFrom("Could not read the snapshot index", cause));
		return;
	}
	const snapshotName = input.snapshotName ?? `snap-${existing + 1}`;
	const id = await newSnapshotId(deps.gen, deps.snapshots);
	if (!id.ok) {
		yield fail(id.error);
		return;
	}
	const running = await isServiceRunning(deps.lifecycle, compose, name);
	if (!running.ok) {
		yield fail(running.error);
		return;
	}
	const wasRunning = running.value;
	const services = { ...compose, services: [name] };

	if (wasRunning) {
		yield serviceStep(`Stopping ${name}`, name, clock);
		const stopped = yield* subStep(
			() => deps.lifecycle.stop(services),
			name,
			clock,
		);
		if (stopped !== undefined) {
			yield stopped;
			return;
		}
	}

	const path = snapshotArchivePath(deps.paths, stack.name, name, id.value);
	yield serviceStep(`Archiving ${volume}`, name, clock);
	const signal = new AbortController().signal;
	let failure: Progress | undefined = yield* subStep(
		() => deps.archiver.archive(volume, path, signal),
		name,
		clock,
	);
	const secretsPath = snapshotSecretsPath(path);
	const discard = async () => {
		// Never leave a half-written archive (or its secrets) behind.
		await deps.archiver.removeArchive(path).catch(() => undefined);
		await deps.archiver.removeArchive(secretsPath).catch(() => undefined);
	};
	if (failure !== undefined) {
		await discard();
	} else {
		try {
			// The archived volume only works with the secrets it was initialised
			// with: keep their values next to the archive, so a restore after a
			// rotation (or a re-created service) puts them back.
			const baked = await bakedSecretValues(deps, stack.name, name, definition);
			if (baked !== undefined) {
				await deps.files.writeText(secretsPath, JSON.stringify(baked), {
					mode: SECRET_FILE_MODE,
				});
			}
			const record: SnapshotRecord = {
				id: id.value,
				project: stack.name,
				service: name,
				name: snapshotName,
				path,
				sizeBytes: await deps.archiver.sizeOf(path),
				createdAt: clock.now().toISOString(),
				type: entry.type,
				version: entry.version ?? definition.defaultVersion,
				...(baked !== undefined && { hasSecrets: true }),
			};
			await deps.snapshots.insert(record);
		} catch (cause) {
			await discard();
			failure = fail(
				ioErrorFrom(`Could not record snapshot "${snapshotName}"`, cause),
			);
		}
	}

	if (wasRunning) {
		yield serviceStep(`Starting ${name}`, name, clock);
		// `up --wait` (not `start`): the op settles once the service is healthy
		// again, so the dashboard's one refetch shows it Running, not Starting.
		const started = yield* subStep(
			() =>
				deps.lifecycle.up({
					...services,
					wait: true,
					waitTimeoutSec: UP_WAIT_TIMEOUT_SEC,
				}),
			name,
			clock,
		);
		failure ??= started;
	}
	if (failure !== undefined) {
		yield failure;
		return;
	}
	yield {
		...serviceStep(`Snapshot “${snapshotName}” created`, name, clock),
		kind: "done",
	};
};

/**
 * @returns The stored values of the definition's `bakedIntoVolume` secrets
 *   for this instance (catalog name → value), or `undefined` when it has none.
 */
async function bakedSecretValues(
	deps: Pick<SnapshotDeps, "secrets">,
	project: string,
	name: string,
	definition: ServiceDefinition,
): Promise<Record<string, string> | undefined> {
	const keys = bakedSecretNames(definition);
	if (keys.length === 0) return undefined;
	const stored = await deps.secrets.read(project);
	const values: Record<string, string> = {};
	for (const key of keys) {
		const value = stored[instanceSecretKey(name, key)];
		if (value !== undefined) values[key] = value;
	}
	return Object.keys(values).length > 0 ? values : undefined;
}
