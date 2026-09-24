import type { ServiceDefinition } from "../catalog/catalog.model";
import { err, ok, type Result } from "../shared/result";
import type { Stack, StackServiceEntry } from "../stack/stack.model";
import { setStackService, updateStackFile } from "../stack/writer";
import { loadProject } from "./load-project.op";
import type {
	UpdateService,
	UpdateServiceDeps,
	UpdateServiceInput,
} from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import { checkComposeVersion } from "./support/compose";
import { provisionAndRender } from "./support/provision";
import {
	checkServiceFields,
	findDefinition,
	findService,
} from "./support/service-input";
import {
	serviceError,
	serviceStep,
	upService,
} from "./support/service-lifecycle";

/**
 * Changes a service's version, port, persistence, config or seed file (the
 * "Use port N" fix is `patch: { port: N }`; `seed: ""` removes the seed): validates the patch (`INVALID_INPUT`),
 * rewrites the entry in `locastack.yaml` (comments kept; `config` replaces
 * the whole map, an empty map removes it), re-pins ports (`PORT_CONFLICT`
 * with `details.suggestedPort`), re-renders compose and re-`up`s the service,
 * which recreates its container. Switching to `ephemeral` never deletes
 * volumes. Every event names the service; ends with one `done` or `error`.
 */
export const updateService: UpdateService = async function* (deps, input) {
	const { name } = input;
	const clock = deps.clock;
	yield serviceStep(`Updating ${name}`, name, clock);

	const prepared = await prepare(deps, input);
	if (!prepared.ok) {
		yield serviceError(prepared.error, name, clock);
		return;
	}
	const { stack, definitions } = prepared.value;
	yield serviceStep(`Updated ${name} in ${stack.filePath}`, name, clock);

	const rendered = await provisionAndRender(deps, stack, definitions);
	if (!rendered.ok) {
		yield serviceError(rendered.error, name, clock);
		return;
	}
	yield serviceStep(`Recreating ${name}`, name, clock);
	yield* upService(deps, stack, name, `${name} is up`);
};

interface Prepared {
	readonly stack: Stack;
	readonly definitions: readonly ServiceDefinition[];
}

/**
 * @param entry - Current entry.
 * @param patch - Fields to change.
 * @returns The entry with the patch applied (`config: {}` removes
 *   `config`, `seed: ""` removes `seed`).
 */
export function applyServicePatch(
	entry: StackServiceEntry,
	patch: UpdateServiceInput["patch"],
): StackServiceEntry {
	const next: StackServiceEntry = { ...entry };
	if (patch.version !== undefined) next.version = patch.version;
	if (patch.port !== undefined) next.port = patch.port;
	if (patch.persist !== undefined) next.persist = patch.persist;
	if (patch.config !== undefined) {
		if (Object.keys(patch.config).length === 0) delete next.config;
		else next.config = { ...patch.config };
	}
	if (patch.seed !== undefined) {
		if (patch.seed === "") delete next.seed;
		else next.seed = patch.seed;
	}
	return next;
}

async function prepare(
	deps: UpdateServiceDeps,
	input: UpdateServiceInput,
): Promise<Result<Prepared>> {
	const loaded = await loadProject(deps, input);
	if (!loaded.ok) return loaded;
	const stack = loaded.value;
	const entry = findService(stack, input.name);
	if (!entry.ok) return entry;
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	const definition = findDefinition(definitions.value, entry.value.type);
	if (!definition.ok) return definition;
	const fields = checkServiceFields(definition.value, input.patch);
	if (!fields.ok) return fields;
	const compose = await checkComposeVersion(deps.compose);
	if (!compose.ok) return compose;

	const next = applyServicePatch(entry.value, input.patch);
	const written = await updateStackFile(deps.files, stack.filePath, (text) =>
		setStackService(text, input.name, next, stack.filePath),
	);
	if (!written.ok) return err(written.error);
	return ok({
		stack: { ...stack, file: written.value },
		definitions: definitions.value,
	});
}
