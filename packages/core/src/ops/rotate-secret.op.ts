import { serviceVolumeName } from "../paths/layout";
import { instanceSecretKey, SECRET_BYTES } from "../resolve/secrets/generator";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { terminalProgress, withService } from "../shared/progress";
import { subStep } from "../shared/sub-progress";
import { DEFAULT_PERSIST_MODE } from "../stack/stack.model";
import { loadProject } from "./load-project.op";
import type { RotateSecret } from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import {
	checkComposeVersion,
	composeTarget,
	UP_WAIT_TIMEOUT_SEC,
} from "./support/compose";
import { provisionAndRender } from "./support/provision";
import {
	dependentsOf,
	findDefinition,
	findService,
} from "./support/service-input";
import { serviceError, serviceStep } from "./support/service-lifecycle";

/** `details.fix` of a refused rotation of a secret baked into the data volume. */
export const BAKED_SECRET_FIX =
	"The password is stored in the data volume on first start; rotating it needs the volume wiped. Take a snapshot first, then rotate with Wipe volume.";

/** `details.fix` of a refused `wipeVolume` without `force`. */
export const WIPE_NEEDS_FORCE_FIX =
	"Deleting the data volume cannot be undone: confirm it (force) together with Wipe volume, or rotate without wiping.";

/**
 * Generates a new value for one secret of a service, stores it (secrets
 * file, then the re-rendered compose `.env`) and recreates the service and
 * its dependents (`compose up --wait <name> <dependents…>`; compose
 * recreates the containers whose interpolated config changed).
 *
 * A secret the catalog marks `bakedIntoVolume` on a service with a data
 * volume (`persist: volume`) is refused (`INVALID_INPUT`, `details.fix` =
 * {@link BAKED_SECRET_FIX}) unless `force` and `wipeVolume` are both set.
 * `wipeVolume` without `force` is refused for every secret (`INVALID_INPUT`,
 * `details.fix` = {@link WIPE_NEEDS_FORCE_FIX}): the wipe is destructive.
 * With `wipeVolume` the steps are "Removing <name>", "Deleting volume
 * <vol>" (the container is removed and its volumes deleted), "Rotating
 * <KEY>", "Starting <name>"; without it "Rotating <KEY>", "Starting <name>".
 * Ends with `done` "Rotated <KEY> of <name>". No event carries the value.
 *
 * Errors (one `error` event): `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`,
 * `INVALID_INPUT` (unknown key, refused baked secret), `COMPOSE_*`,
 * `PORT_CONFLICT`, `IO`, or the compose error.
 */
export const rotateSecret: RotateSecret = async function* (deps, input) {
	const { name, key } = input;
	const clock = deps.clock;
	const fail = (error: OpError) => serviceError(error, name, clock);

	const loaded = await loadProject(deps, input);
	if (!loaded.ok) {
		yield fail(loaded.error);
		return;
	}
	const stack = loaded.value;
	const entry = findService(stack, name);
	if (!entry.ok) {
		yield fail(entry.error);
		return;
	}
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) {
		yield fail(definitions.error);
		return;
	}
	const definition = findDefinition(definitions.value, entry.value.type);
	if (!definition.ok) {
		yield fail(definition.error);
		return;
	}
	const def = definition.value;
	if (!def.secrets.includes(key)) {
		yield fail(
			new OpError("INVALID_INPUT", `${def.name} has no secret "${key}"`, {
				details: {
					key,
					fix: `Known secrets: ${def.secrets.join(", ") || "none"}.`,
				},
			}),
		);
		return;
	}
	const hasVolume =
		(entry.value.persist ?? DEFAULT_PERSIST_MODE) === "volume" &&
		def.volumes.length > 0;
	const baked = def.secretOptions?.[key]?.bakedIntoVolume === true && hasVolume;
	if (baked && !(input.force === true && input.wipeVolume === true)) {
		yield fail(
			new OpError(
				"INVALID_INPUT",
				`${key} of ${name} is stored in its data volume; rotating it needs the volume wiped`,
				{
					details: { key, reason: "baked-into-volume", fix: BAKED_SECRET_FIX },
				},
			),
		);
		return;
	}
	// Deleting a volume is destructive for every secret, baked or not.
	if (input.wipeVolume === true && input.force !== true) {
		yield fail(
			new OpError(
				"INVALID_INPUT",
				`Wiping the data volume of ${name} needs force`,
				{
					details: {
						key,
						reason: "wipe-needs-force",
						fix: WIPE_NEEDS_FORCE_FIX,
					},
				},
			),
		);
		return;
	}
	const compose = await checkComposeVersion(deps.compose);
	if (!compose.ok) {
		yield fail(compose.error);
		return;
	}

	const target = composeTarget(deps.paths, stack.name);
	if (input.wipeVolume === true && hasVolume) {
		yield serviceStep(`Removing ${name}`, name, clock);
		const volumes = def.volumes.map((v) =>
			serviceVolumeName(stack.name, name, v.name),
		);
		for (const volume of volumes) {
			yield serviceStep(`Deleting volume ${volume}`, name, clock);
		}
		let rendered: boolean;
		try {
			rendered = await deps.files.exists(target.composeFile);
		} catch {
			rendered = true;
		}
		if (rendered) {
			const removed = yield* subStep(
				() => deps.lifecycle.remove({ ...target, services: [name], volumes }),
				name,
				clock,
			);
			if (removed !== undefined) {
				yield removed;
				return;
			}
		}
	}

	yield serviceStep(`Rotating ${key}`, name, clock);
	const secretKey = instanceSecretKey(name, key);
	try {
		await deps.secrets.update(stack.name, (current) => ({
			...current,
			[secretKey]: deps.gen.generate(SECRET_BYTES),
		}));
	} catch (cause) {
		yield fail(ioErrorFrom(`Could not store the new ${key} of ${name}`, cause));
		return;
	}
	const rendered = await provisionAndRender(deps, stack, definitions.value);
	if (!rendered.ok) {
		yield fail(rendered.error);
		return;
	}

	yield serviceStep(`Starting ${name}`, name, clock);
	const services = [name, ...dependentsOf(stack, definitions.value, name)];
	for await (const event of withService(
		terminalProgress(
			() =>
				deps.lifecycle.up({
					...target,
					services,
					wait: true,
					waitTimeoutSec: UP_WAIT_TIMEOUT_SEC,
				}),
			`Rotated ${key} of ${name}`,
			clock,
		),
		name,
	)) {
		yield event.kind === "done"
			? { ...event, message: `Rotated ${key} of ${name}` }
			: event;
	}
};
