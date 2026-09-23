import { instanceSecretKey } from "../resolve/secrets/generator";
import { ioErrorFrom, type OpError } from "../shared/op-error";
import type { Progress } from "../shared/progress.model";
import { err, ok, type Result } from "../shared/result";
import { subStep } from "../shared/sub-progress";
import type { RestoreSnapshot, RestoreSnapshotDeps } from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import { UP_WAIT_TIMEOUT_SEC } from "./support/compose";
import { provisionAndRender } from "./support/provision";
import { dependentsOf } from "./support/service-input";
import { serviceError, serviceStep } from "./support/service-lifecycle";
import {
	findSnapshot,
	loadSnapshotTarget,
	readSnapshotSecrets,
	type SnapshotTarget,
	snapshotMismatch,
	snapshotNotFound,
} from "./support/snapshots";

/**
 * Replaces a service's data volume with a snapshot. Steps: "Stopping
 * <name>", "Restoring “<snapshot>”" (the archiver extracts into a staging
 * folder, then swaps, so a failed extraction leaves the data as it was),
 * "Restoring <KEY…> saved with the snapshot" (only when the secrets baked
 * into the archived volume differ from the stored ones: the snapshot's
 * values are stored again and compose re-rendered, so `.env` and
 * `DATABASE_URL` match the restored data), "Starting <name>" (`up --wait`;
 * always, also after a failed restore; with its dependents when secrets
 * changed, as a rotation does), then `done` "Restored “<snapshot>” into
 * <name>". No event carries a secret value.
 *
 * Errors (one `error` event): `SNAPSHOT_NOT_FOUND` when the id is unknown,
 * belongs to another service or its file (or secrets sidecar) is gone;
 * `INVALID_INPUT` when it was taken from another catalog type or major
 * version (`details.reason` `type-mismatch` / `version-mismatch`, nothing
 * is stopped); otherwise as `createSnapshot`.
 */
export const restoreSnapshot: RestoreSnapshot = async function* (deps, input) {
	const { name } = input;
	const clock = deps.clock;
	const fail = (error: OpError) => serviceError(error, name, clock);

	const target = await loadSnapshotTarget(deps, input);
	if (!target.ok) {
		yield fail(target.error);
		return;
	}
	const { volume, compose, entry, definition } = target.value;
	const found = await findSnapshot(deps.snapshots, input);
	if (!found.ok) {
		yield fail(found.error);
		return;
	}
	const snapshot = found.value;
	const mismatch = snapshotMismatch(snapshot, entry, definition);
	if (mismatch !== undefined) {
		yield fail(mismatch);
		return;
	}
	try {
		await deps.archiver.sizeOf(snapshot.path);
	} catch {
		yield fail(snapshotNotFound(snapshot.id, input, "its file is gone"));
		return;
	}
	const saved = await readSnapshotSecrets(
		deps.files,
		snapshot,
		definition,
		input,
	);
	if (!saved.ok) {
		yield fail(saved.error);
		return;
	}
	const changed = await changedSecrets(deps, target.value, name, saved.value);
	if (!changed.ok) {
		yield fail(changed.error);
		return;
	}

	yield serviceStep(`Stopping ${name}`, name, clock);
	const stopped = yield* subStep(
		() => deps.lifecycle.stop({ ...compose, services: [name] }),
		name,
		clock,
	);
	if (stopped !== undefined) {
		yield stopped;
		return;
	}

	yield serviceStep(`Restoring “${snapshot.name}”`, name, clock);
	const signal = new AbortController().signal;
	let failure: Progress | undefined = yield* subStep(
		() => deps.archiver.restore(volume, snapshot.path, signal),
		name,
		clock,
	);

	let services = [name];
	const keys = Object.keys(changed.value);
	if (failure === undefined && keys.length > 0) {
		yield serviceStep(
			`Restoring ${keys.join(", ")} saved with the snapshot`,
			name,
			clock,
		);
		const put = await putBackSecrets(deps, target.value, name, changed.value);
		if (put.ok) services = put.value;
		else failure = fail(put.error);
	}

	yield serviceStep(`Starting ${name}`, name, clock);
	const started = yield* subStep(
		() =>
			deps.lifecycle.up({
				...compose,
				services,
				wait: true,
				waitTimeoutSec: UP_WAIT_TIMEOUT_SEC,
			}),
		name,
		clock,
	);
	failure ??= started;
	if (failure !== undefined) {
		yield failure;
		return;
	}
	yield {
		...serviceStep(`Restored “${snapshot.name}” into ${name}`, name, clock),
		kind: "done",
	};
};

/**
 * @returns The snapshot's baked-in secrets whose stored value differs
 *   (catalog name → the snapshot's value), or `IO`.
 */
async function changedSecrets(
	deps: RestoreSnapshotDeps,
	target: SnapshotTarget,
	service: string,
	saved: Readonly<Record<string, string>>,
): Promise<Result<Record<string, string>>> {
	if (Object.keys(saved).length === 0) return ok({});
	let stored: Record<string, string>;
	try {
		stored = await deps.secrets.read(target.stack.name);
	} catch (cause) {
		return err(
			ioErrorFrom(
				`Could not read the secrets of "${target.stack.name}"`,
				cause,
			),
		);
	}
	const changed: Record<string, string> = {};
	for (const [key, value] of Object.entries(saved)) {
		if (stored[instanceSecretKey(service, key)] !== value) changed[key] = value;
	}
	return ok(changed);
}

/**
 * Stores the snapshot's secret values again and re-renders compose.
 *
 * @returns The services to start (the restored one and its dependents), or
 *   the error.
 */
async function putBackSecrets(
	deps: RestoreSnapshotDeps,
	target: SnapshotTarget,
	service: string,
	values: Readonly<Record<string, string>>,
): Promise<Result<string[]>> {
	const { stack } = target;
	try {
		await deps.secrets.update(stack.name, (current) => {
			const next = { ...current };
			for (const [key, value] of Object.entries(values)) {
				next[instanceSecretKey(service, key)] = value;
			}
			return next;
		});
	} catch (cause) {
		return err(
			ioErrorFrom(
				`Could not store the secrets saved with the snapshot of ${service}`,
				cause,
			),
		);
	}
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	const rendered = await provisionAndRender(deps, stack, definitions.value);
	if (!rendered.ok) return rendered;
	return ok([service, ...dependentsOf(stack, definitions.value, service)]);
}
