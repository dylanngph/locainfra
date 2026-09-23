import type { ServiceDefinition } from "../catalog/catalog.model";
import { planStack } from "../resolve/plan";
import { instanceSecretKey } from "../resolve/secrets/generator";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import {
	containerNameClashError,
	findContainerNameClash,
} from "../stack/project-registry";
import { DEFAULT_PERSIST_MODE, type Stack } from "../stack/stack.model";
import { addStackService, updateStackFile } from "../stack/writer";
import { loadProject } from "./load-project.op";
import type {
	AddService,
	AddServiceDeps,
	AddServiceInput,
} from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import { checkComposeVersion } from "./support/compose";
import { provisionAndRender } from "./support/provision";
import {
	buildEntry,
	checkName,
	checkSecretValues,
	checkServiceFields,
	findDefinition,
} from "./support/service-input";
import {
	serviceError,
	serviceStep,
	upService,
} from "./support/service-lifecycle";

/**
 * Adds a service instance to a registered project and starts it:
 *
 * 1. validates the input against the catalog (`INVALID_INPUT` for a bad
 *    name, unknown type/version/config key, a bad or unsupported `seed`,
 *    unknown secret names or values outside `SECRET_VALUE_PATTERN`, or an
 *    unmet `dependsOn`;
 *    `SERVICE_EXISTS` for a taken name or a container name another project
 *    uses) and the compose version;
 * 2. writes the entry to `locainfra.yaml` (comments kept, `seed`
 *    included) and stores the client-chosen `secrets` (a stored
 *    `bakedIntoVolume` value of a previous instance with that name is kept,
 *    reported as a `log` event without the value);
 * 3. pins its port and generates its secrets (`PORT_CONFLICT` with
 *    `details.suggestedPort` when an explicit port is busy; the entry stays
 *    so the dashboard can offer "Use port N"), renders compose;
 * 4. `compose up -d --wait <name>`.
 *
 * Every event names the service; ends with exactly one `done` or `error`.
 */
export const addService: AddService = async function* (deps, input) {
	const { name } = input;
	const clock = deps.clock;
	yield serviceStep(`Adding ${name}`, name, clock);

	const prepared = await prepare(deps, input);
	if (!prepared.ok) {
		yield serviceError(prepared.error, name, clock);
		return;
	}
	const { stack, definitions, keptSecrets } = prepared.value;
	yield serviceStep(`Added ${name} to ${stack.filePath}`, name, clock);
	for (const secret of keptSecrets) {
		yield {
			...serviceStep(
				`Kept the stored ${secret} of ${name}: its data volume was initialised with it`,
				name,
				clock,
			),
			kind: "log",
		};
	}

	const rendered = await provisionAndRender(deps, stack, definitions);
	if (!rendered.ok) {
		yield serviceError(rendered.error, name, clock);
		return;
	}
	yield serviceStep(`Starting ${name}`, name, clock);
	yield* upService(deps, stack, name, `${name} is up`);
};

interface Prepared {
	readonly stack: Stack;
	readonly definitions: readonly ServiceDefinition[];
	/** Client-chosen secrets not stored because a baked value already exists. */
	readonly keptSecrets: readonly string[];
}

async function prepare(
	deps: AddServiceDeps,
	input: AddServiceInput,
): Promise<Result<Prepared>> {
	const named = checkName(input.name, "service");
	if (!named.ok) return named;
	const loaded = await loadProject(deps, input);
	if (!loaded.ok) return loaded;
	const stack = loaded.value;
	if (Object.hasOwn(stack.file.services, input.name)) {
		return err(
			new OpError(
				"SERVICE_EXISTS",
				`Project "${stack.name}" already has a service "${input.name}"`,
				{
					details: {
						project: stack.name,
						service: input.name,
						fix: "Pick another name.",
					},
				},
			),
		);
	}
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	const definition = findDefinition(definitions.value, input.type);
	if (!definition.ok) return definition;
	const fields = checkServiceFields(definition.value, input);
	if (!fields.ok) return fields;
	const secretValues = checkSecretValues(definition.value, input.secrets);
	if (!secretValues.ok) return secretValues;

	const entry = buildEntry(input.type, input);
	const candidate: Stack = {
		...stack,
		file: {
			...stack.file,
			services: { ...stack.file.services, [input.name]: entry },
		},
	};
	const plan = planStack(candidate, definitions.value);
	if (!plan.ok) {
		return err(
			new OpError("INVALID_INPUT", plan.error.message, {
				cause: plan.error,
				details: plan.error.details,
			}),
		);
	}
	try {
		const clash = await findContainerNameClash(deps, {
			name: stack.name,
			root: stack.root,
			services: [input.name],
		});
		if (clash !== undefined) {
			return err(containerNameClashError(clash, "SERVICE_EXISTS"));
		}
	} catch (cause) {
		return err(
			ioErrorFrom("Could not read the LocaInfra project registry", cause),
		);
	}
	const compose = await checkComposeVersion(deps.compose);
	if (!compose.ok) return compose;

	const written = await updateStackFile(deps.files, stack.filePath, (text) =>
		addStackService(text, input.name, entry, stack.filePath),
	);
	if (!written.ok) return written;
	const stored = await storeChosenSecrets(
		deps,
		stack.name,
		input,
		definition.value,
	);
	if (!stored.ok) return stored;
	return ok({
		stack: { ...stack, file: written.value },
		definitions: definitions.value,
		keptSecrets: stored.value,
	});
}

/**
 * Stores the client-chosen initial secrets before the first `up` (the rest
 * are generated on provisioning). A secret the catalog marks
 * `bakedIntoVolume` that is already stored for this instance name (a
 * previous instance removed without its volumes) is kept: its data volume
 * was initialised with the stored value.
 *
 * @returns The names of the secrets that were kept, or `IO`.
 */
async function storeChosenSecrets(
	deps: AddServiceDeps,
	stack: string,
	input: AddServiceInput,
	definition: ServiceDefinition,
): Promise<Result<string[]>> {
	const chosen = Object.entries(input.secrets ?? {});
	if (chosen.length === 0) return ok([]);
	const persist = input.persist ?? DEFAULT_PERSIST_MODE;
	const kept: string[] = [];
	try {
		await deps.secrets.update(stack, (current) => {
			const next = { ...current };
			for (const [name, value] of chosen) {
				const key = instanceSecretKey(input.name, name);
				const baked =
					definition.secretOptions?.[name]?.bakedIntoVolume === true &&
					persist === "volume" &&
					definition.volumes.length > 0;
				if (baked && (current[key] ?? "") !== "" && current[key] !== value) {
					kept.push(name);
					continue;
				}
				next[key] = value;
			}
			return next;
		});
	} catch (cause) {
		return err(
			ioErrorFrom(`Could not store the secrets of "${input.name}"`, cause, {
				stack,
				service: input.name,
			}),
		);
	}
	return ok(kept);
}
