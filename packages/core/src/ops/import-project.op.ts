import { join } from "node:path";
import type { ServiceDefinition } from "../catalog/catalog.model";
import { planStack } from "../resolve/plan";
import { portsReservedByOtherStacks } from "../resolve/ports/ranges";
import { instanceSecretKey } from "../resolve/secrets/generator";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { errorProgress, withTimestamp } from "../shared/progress";
import type { Progress } from "../shared/progress.model";
import { err, ok, type Result } from "../shared/result";
import { parseStackFile, stackErrorToOpError } from "../stack/loader";
import {
	containerNameClashError,
	findContainerNameClash,
	findProjectEntry,
} from "../stack/project-registry";
import {
	PROJECT_STACK_FILE_NAME,
	type Stack,
	type StackServiceEntry,
} from "../stack/stack.model";
import { renderStackFile } from "../stack/writer";
import type {
	ImportProject,
	ImportProjectDeps,
	ImportProjectInput,
} from "./ops.contract";
import { IMPORT_SECRET_VALUE_PATTERN, type ImportItem } from "./ops.model";
import { loadDefinitions } from "./support/catalog";
import { checkProjectInput, registerStack } from "./support/registration";
import {
	checkName,
	checkServiceFields,
	findDefinition,
} from "./support/service-input";
import { upStack } from "./up-stack.op";

const IMPORT_SECRET_VALUE = new RegExp(IMPORT_SECRET_VALUE_PATTERN);

/** A validated import: the stack to write and the secrets to store. */
interface ImportPlanned {
	readonly stack: Stack;
	readonly text: string;
	/** Secret store key → value (never log). */
	readonly secrets: Readonly<Record<string, string>>;
	readonly services: readonly string[];
	readonly remapped: number;
}

/**
 * Creates a project from Import preview items. Re-validates the included
 * items (`supported && include`, at least one) against the catalog (type,
 * version, config keys and patterns, secret names and values, unique
 * instance names, `dependsOn` satisfied), the registry (`PROJECT_EXISTS`
 * when the name is registered, `<root>/locainfra.yaml` exists or a
 * container name clashes) and the host (`PORT_CONFLICT` when a `hostPort`
 * is pinned by another project or busy on 127.0.0.1 since the preview).
 *
 * Steps: "Creating <root>" (mkdir when missing), "Registering <name>",
 * "Storing secrets" (the supplied values; the rest are generated on the
 * first `up`), "Writing locainfra.yaml" (one entry per item: type, version,
 * `port: hostPort` or auto, `persist: volume`, config), then with `start`
 * "Starting N services" (`upStack`), then `done` "Imported N services into
 * <name>[, M ports remapped]". The project is registered before the file is
 * written and unregistered again when storing secrets or writing fails, so
 * a failed import leaves no registration and no `locainfra.yaml` behind.
 */
export const importProject: ImportProject = async function* (deps, input) {
	const clock = deps.clock;
	const step = (message: string): Progress =>
		withTimestamp({ kind: "step", message }, clock);
	const fail = (error: OpError): Progress => errorProgress(error, clock);

	const planned = await plan(deps, input);
	if (!planned.ok) {
		yield fail(planned.error);
		return;
	}
	const { stack, text, secrets, services, remapped } = planned.value;

	yield step(`Creating ${stack.root}`);
	try {
		if (!(await deps.files.isDirectory(stack.root))) {
			await deps.files.mkdirp(stack.root);
		}
	} catch (cause) {
		yield fail(
			ioErrorFrom(`Could not create ${stack.root}`, cause, {
				root: stack.root,
			}),
		);
		return;
	}

	yield step(`Registering ${stack.name}`);
	const registered = await registerStack(deps, stack);
	if (!registered.ok) {
		yield fail(registered.error);
		return;
	}

	yield step("Storing secrets");
	try {
		if (Object.keys(secrets).length > 0) {
			await deps.secrets.update(stack.name, (current) => ({
				...current,
				...secrets,
			}));
		}
	} catch (cause) {
		await unregister(deps, stack.name);
		yield fail(
			ioErrorFrom(`Could not store the secrets of "${stack.name}"`, cause),
		);
		return;
	}

	yield step(`Writing ${PROJECT_STACK_FILE_NAME}`);
	try {
		await deps.files.writeText(stack.filePath, text);
	} catch (cause) {
		await unregister(deps, stack.name);
		yield fail(
			ioErrorFrom(`Could not write ${stack.filePath}`, cause, {
				filePath: stack.filePath,
			}),
		);
		return;
	}

	const count = services.length;
	const summary = `Imported ${count} service${count === 1 ? "" : "s"} into ${stack.name}${
		remapped > 0
			? `, ${remapped} port${remapped === 1 ? "" : "s"} remapped`
			: ""
	}`;
	if (input.start) {
		yield step(`Starting ${count} service${count === 1 ? "" : "s"}`);
		for await (const event of upStack(deps, { stack })) {
			if (event.kind === "done") {
				yield { ...event, message: summary };
				return;
			}
			yield event;
			if (event.kind === "error") return;
		}
		return;
	}
	yield withTimestamp({ kind: "done", message: summary }, clock);
};

async function unregister(
	deps: ImportProjectDeps,
	name: string,
): Promise<void> {
	await deps.state
		.update((state) => ({
			...state,
			projects: state.projects.filter((p) => p.name !== name),
		}))
		.catch(() => undefined);
}

function invalid(
	message: string,
	details: Record<string, unknown>,
): Result<never> {
	return err(new OpError("INVALID_INPUT", message, { details }));
}

async function plan(
	deps: ImportProjectDeps,
	input: ImportProjectInput,
): Promise<Result<ImportPlanned>> {
	const root = checkProjectInput(input.name, input.root);
	if (!root.ok) return root;
	const filePath = join(root.value, PROJECT_STACK_FILE_NAME);
	const included = input.items.filter((item) => item.supported && item.include);
	if (included.length === 0) {
		return invalid("Nothing to import", {
			fix: "Check at least one supported service in the preview.",
		});
	}
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;

	const services: Record<string, StackServiceEntry> = {};
	const secrets: Record<string, string> = {};
	for (const item of included) {
		const entry = checkItem(definitions.value, item, services);
		if (!entry.ok) return entry;
		services[item.name] = entry.value.entry;
		for (const [name, value] of Object.entries(entry.value.secrets)) {
			secrets[instanceSecretKey(item.name, name)] = value;
		}
	}

	const text = renderStackFile({ version: 1, name: input.name, services });
	const parsed = parseStackFile(text, filePath);
	if (!parsed.ok) return err(stackErrorToOpError(parsed.error));
	const stack: Stack = {
		name: input.name,
		root: root.value,
		filePath,
		file: parsed.value,
	};
	const planned = planStack(stack, definitions.value);
	if (!planned.ok) {
		return err(
			new OpError("INVALID_INPUT", planned.error.message, {
				cause: planned.error,
				details: planned.error.details,
			}),
		);
	}

	const taken = await checkRegistry(deps, stack);
	if (!taken.ok) return taken;
	const ports = await checkPorts(deps, stack, included);
	if (!ports.ok) return ports;

	return ok({
		stack,
		text,
		secrets,
		services: Object.keys(services),
		remapped: included.filter(
			(item) =>
				item.hostPort !== undefined &&
				item.wantedPort !== undefined &&
				item.hostPort !== item.wantedPort,
		).length,
	});
}

function checkItem(
	definitions: readonly ServiceDefinition[],
	item: ImportItem,
	services: Readonly<Record<string, StackServiceEntry>>,
): Result<{ entry: StackServiceEntry; secrets: Record<string, string> }> {
	const named = checkName(item.name, "service");
	if (!named.ok) return named;
	if (Object.hasOwn(services, item.name)) {
		return invalid(`Two services are named "${item.name}"`, {
			service: item.name,
			fix: "Rename one of them in the preview.",
		});
	}
	if (item.type === undefined) {
		return invalid(`"${item.composeName}" has no service type`, {
			service: item.name,
			fix: "Uncheck it in the preview.",
		});
	}
	const definition = findDefinition(definitions, item.type);
	if (!definition.ok) return definition;
	const fields = checkServiceFields(definition.value, {
		...(item.version !== undefined && { version: item.version }),
		...(item.hostPort !== undefined && { port: item.hostPort }),
		config: item.config,
	});
	if (!fields.ok) return fields;
	for (const [name, value] of Object.entries(item.secrets)) {
		if (!definition.value.secrets.includes(name)) {
			return invalid(`Unknown secret "${name}" for ${definition.value.name}`, {
				service: item.name,
				key: name,
				fix: `Known secrets: ${definition.value.secrets.join(", ") || "none"}.`,
			});
		}
		if (!IMPORT_SECRET_VALUE.test(value)) {
			return invalid(
				`The value of ${name} of "${item.name}" is not a valid secret`,
				{
					service: item.name,
					key: name,
					fix: "Leave it out: LocaInfra generates one.",
				},
			);
		}
	}
	const entry: StackServiceEntry = {
		type: item.type,
		...(item.version !== undefined && { version: item.version }),
		...(item.hostPort !== undefined && { port: item.hostPort }),
		persist: "volume",
		...(Object.keys(item.config).length > 0 && { config: { ...item.config } }),
	};
	return ok({ entry, secrets: { ...item.secrets } });
}

async function checkRegistry(
	deps: ImportProjectDeps,
	stack: Stack,
): Promise<Result<void>> {
	try {
		const owner = findProjectEntry(await deps.state.read(), stack.name);
		if (owner !== undefined) {
			return err(
				new OpError(
					"PROJECT_EXISTS",
					`A project named "${stack.name}" is already registered at ${owner.root}`,
					{
						details: {
							reason: "name-taken",
							project: stack.name,
							registeredRoot: owner.root,
							fix: "Pick another project name.",
						},
					},
				),
			);
		}
		if (await deps.files.exists(stack.filePath)) {
			return err(
				new OpError("PROJECT_EXISTS", `${stack.filePath} already exists`, {
					details: {
						reason: "file-exists",
						filePath: stack.filePath,
						fix: "Pick another folder, or register the existing project instead.",
					},
				}),
			);
		}
		const clash = await findContainerNameClash(deps, {
			name: stack.name,
			root: stack.root,
			services: Object.keys(stack.file.services),
		});
		if (clash !== undefined)
			return err(containerNameClashError(clash, "PROJECT_EXISTS"));
	} catch (cause) {
		return err(
			ioErrorFrom("Could not read the LocaInfra project registry", cause),
		);
	}
	return ok(undefined);
}

async function checkPorts(
	deps: ImportProjectDeps,
	stack: Stack,
	items: readonly ImportItem[],
): Promise<Result<void>> {
	let reserved: ReturnType<typeof portsReservedByOtherStacks>;
	try {
		reserved = portsReservedByOtherStacks(await deps.state.read(), stack.name);
	} catch (cause) {
		return err(ioErrorFrom("Could not read LocaInfra state", cause));
	}
	const claimed = new Map<number, string>();
	for (const item of items) {
		const port = item.hostPort;
		if (port === undefined) continue;
		const owner = reserved.get(port);
		const other = claimed.get(port);
		let reason: string | undefined;
		if (other !== undefined) reason = `is also chosen for ${other}`;
		else if (owner !== undefined)
			reason = `is used by ${owner.stack}/${owner.service}`;
		else {
			let free: boolean;
			try {
				free = await deps.probe.isFree(port);
			} catch {
				free = false;
			}
			if (!free) reason = "is in use on this machine";
		}
		if (reason !== undefined) {
			return err(
				new OpError(
					"PORT_CONFLICT",
					`Port ${port} for ${item.name} ${reason}`,
					{
						details: {
							port,
							service: item.name,
							fix: "Run the preview again to pick free ports.",
						},
					},
				),
			);
		}
		claimed.set(port, item.name);
	}
	return ok(undefined);
}
