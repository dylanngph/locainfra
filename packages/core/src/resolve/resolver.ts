import { posix, resolve, sep } from "node:path";
import type { ServiceDefinition } from "../catalog/catalog.model";
import { MASKED_SECRET } from "../ops/ops.model";
import {
	composeProjectName,
	serviceContainerName,
	serviceVolumeName,
} from "../paths/layout";
import type { StateFile } from "../ports/state.port";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import { DEFAULT_PERSIST_MODE, type Stack } from "../stack/stack.model";
import {
	renderTemplate,
	renderTemplateList,
	renderTemplateRecord,
} from "../template/template";
import type {
	TemplateContext,
	TemplateServiceContext,
} from "../template/template.model";
import { TemplateError } from "../template/template.model";
import { type PlannedService, planStack } from "./plan";
import type {
	ResolvedHealthcheck,
	ResolvedSeedMount,
	ResolvedService,
	ResolvedStack,
} from "./resolved.model";
import { instanceSecretKey } from "./secrets/generator";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Input of {@link resolveStack}. */
export interface ResolveStackInput {
	/** The stack to resolve. */
	readonly stack: Stack;
	/** The merged catalog. */
	readonly definitions: readonly ServiceDefinition[];
	/** Persisted state (pinned host ports). */
	readonly state: StateFile;
	/** The stack's secrets, keyed by `instanceSecretKey` (never logged). */
	readonly secrets: Readonly<Record<string, string>>;
	/**
	 * What to do with a service that has no host port or secret yet (never
	 * started): `error` (default) fails with `INVALID_STACK`; `placeholder`
	 * resolves it anyway with host port {@link UNPROVISIONED_PORT} and every
	 * missing secret set to {@link UNPROVISIONED_SECRET}. Read-only views
	 * (status, previews) use `placeholder`; anything that writes files or
	 * starts containers must use `error`.
	 */
	readonly unprovisioned?: "error" | "placeholder";
}

/** Host port reported for a service whose port is not pinned yet (placeholder mode). */
export const UNPROVISIONED_PORT = 0;

/** Secret value used for a secret that was never generated (placeholder mode). */
export const UNPROVISIONED_SECRET = MASKED_SECRET;

/**
 * Resolves a stack into concrete services: versions, host ports, config,
 * secrets, env, exports, volumes and healthchecks, with every `{{path}}`
 * template evaluated. Pure: no I/O.
 *
 * Host ports come from the stack file (`port: <n>`), else the pin in state. Run
 * `allocatePorts` and `ensureSecrets` first when provisioning; a read-only
 * caller (e.g. `env`) gets `INVALID_STACK` for an unprovisioned stack unless
 * it asks for placeholders (`unprovisioned: "placeholder"`).
 *
 * Templates see the instance `name`, and each `dependsOn` dependency as
 * `services.<catalogId>`, `services.<instanceName>` and `byType.<catalogId>`.
 *
 * @param input - Stack, catalog, state and secrets.
 * @returns The resolved stack in dependency order, or `INVALID_STACK` /
 *   `INVALID_CATALOG`. Error messages never contain secret values.
 */
export function resolveStack(input: ResolveStackInput): Result<ResolvedStack> {
	const plan = planStack(input.stack, input.definitions);
	if (!plan.ok) return plan;

	const resolved = new Map<string, ResolvedService>();
	for (const service of plan.value) {
		const result = resolveService(input, service, resolved);
		if (!result.ok) return result;
		resolved.set(service.name, result.value);
	}

	const projectName = composeProjectName(input.stack.name);
	return ok({
		name: input.stack.name,
		projectName,
		network: projectName,
		services: [...resolved.values()],
	});
}

function hostPortOf(
	input: ResolveStackInput,
	service: PlannedService,
): Result<number> {
	const requested = service.entry.port;
	if (typeof requested === "number") return ok(requested);
	const pinned = input.state.stacks[input.stack.name]?.ports[service.name];
	if (pinned !== undefined) return ok(pinned);
	if (input.unprovisioned === "placeholder") return ok(UNPROVISIONED_PORT);
	return err(notProvisioned(input.stack, service.name, "host port"));
}

function notProvisioned(stack: Stack, service: string, what: string): OpError {
	return new OpError(
		"INVALID_STACK",
		`Stack "${stack.name}" has no ${what} for "${service}" yet`,
		{
			details: {
				stack: stack.name,
				service,
				reason: "unprovisioned",
				fix: "Start the stack once (locastack up) so ports and secrets are provisioned.",
			},
		},
	);
}

function invalid(stack: Stack, service: string, message: string, fix: string) {
	return err(
		new OpError("INVALID_STACK", message, {
			details: { stack: stack.name, service, filePath: stack.filePath, fix },
		}),
	);
}

function templateFailure(service: PlannedService, cause: unknown) {
	const paths = cause instanceof TemplateError ? [...cause.paths] : [];
	return err(
		new OpError(
			"INVALID_CATALOG",
			`Catalog definition "${service.definition.id}" has unresolved templates${paths.length > 0 ? `: ${paths.map((p) => `{{${p}}}`).join(", ")}` : ""}`,
			{
				cause,
				details: {
					service: service.name,
					catalogId: service.definition.id,
					paths,
					fix: "Fix the definition (catalog override or registry entry) or add the missing dependsOn.",
				},
			},
		),
	);
}

/**
 * The seed bind mount of a service: `<root>/<entry.seed>` read-only at
 * `<seed.mountPath>/<seed.fileName>`. The stack schema already rejects
 * absolute and `..` paths; the resolved source is checked again to stay
 * inside the project folder. Symlinks are checked on disk by the compose
 * writer (`verifySeedMounts`), which this pure function cannot do.
 */
function seedMountOf(
	stack: Stack,
	service: PlannedService,
): Result<ResolvedSeedMount | undefined> {
	const file = service.entry.seed;
	const block = service.definition.seed;
	if (file === undefined || block === undefined) return ok(undefined);
	const root = resolve(stack.root);
	const source = resolve(root, file);
	if (!source.startsWith(`${root}${sep}`)) {
		return invalid(
			stack,
			service.name,
			`Seed file "${file}" of "${service.name}" is not a file inside the project folder`,
			`Set services.${service.name}.seed in ${stack.filePath} to a path inside ${stack.root}.`,
		);
	}
	return ok({
		source,
		root,
		target: posix.join(block.mountPath, block.fileName),
	});
}

function resolveService(
	input: ResolveStackInput,
	service: PlannedService,
	resolved: ReadonlyMap<string, ResolvedService>,
): Result<ResolvedService> {
	const { stack } = input;
	const { definition, entry, name: id } = service;

	const version = entry.version ?? definition.defaultVersion;
	if (!VERSION_PATTERN.test(version)) {
		return invalid(
			stack,
			id,
			`Version "${version}" of "${id}" is not a valid image tag`,
			`Pick one of: ${definition.versions.join(", ")}.`,
		);
	}

	const hostPort = hostPortOf(input, service);
	if (!hostPort.ok) return hostPort;

	const seed = seedMountOf(stack, service);
	if (!seed.ok) return seed;

	const unknownConfig = Object.keys(entry.config ?? {}).filter(
		(key) => !Object.hasOwn(definition.config, key),
	);
	if (unknownConfig.length > 0) {
		return invalid(
			stack,
			id,
			`Unknown config for "${id}": ${unknownConfig.join(", ")}`,
			`Known config keys: ${Object.keys(definition.config).join(", ") || "none"}.`,
		);
	}

	const secrets: Record<string, string> = {};
	for (const name of definition.secrets) {
		const value = input.secrets[instanceSecretKey(id, name)];
		if (value === undefined || value === "") {
			if (input.unprovisioned !== "placeholder") {
				return err(notProvisioned(stack, id, `secret ${name}`));
			}
			secrets[name] = UNPROVISIONED_SECRET;
			continue;
		}
		secrets[name] = value;
	}

	const dependsOn = [...new Set(Object.values(service.dependencies))];
	const byType: Record<string, TemplateServiceContext> = {};
	const byInstance: Record<string, TemplateServiceContext> = {};
	for (const [type, instance] of Object.entries(service.dependencies)) {
		const target = resolved.get(instance);
		if (target) {
			const context: TemplateServiceContext = {
				host: target.name,
				port: target.hostPort,
				secrets: target.secrets,
				config: target.config,
			};
			byType[type] = context;
			byInstance[instance] = context;
		}
	}
	// Catalog-id keys win: definitions reference their dependencies by type.
	const services = { ...byInstance, ...byType };

	try {
		const base: TemplateContext = {
			name: id,
			version,
			port: hostPort.value,
			stack: { name: stack.name },
			config: {},
			secrets,
			services,
			byType,
		};
		const config: Record<string, string> = {};
		for (const [key, value] of Object.entries(definition.config)) {
			config[key] = entry.config?.[key] ?? renderTemplate(value.default, base);
			if (
				value.pattern !== undefined &&
				!new RegExp(value.pattern).test(config[key])
			) {
				return invalid(
					stack,
					id,
					`config.${key} of "${id}" must match ${value.pattern}`,
					`Set services.${id}.config.${key} in ${stack.filePath} to a value matching ${value.pattern}.`,
				);
			}
		}
		const context: TemplateContext = { ...base, config };

		const healthcheck: ResolvedHealthcheck = {
			test: renderTemplateList(definition.healthcheck.test, context),
			...(definition.healthcheck.interval !== undefined && {
				interval: definition.healthcheck.interval,
			}),
			...(definition.healthcheck.timeout !== undefined && {
				timeout: definition.healthcheck.timeout,
			}),
			...(definition.healthcheck.retries !== undefined && {
				retries: definition.healthcheck.retries,
			}),
			...(definition.healthcheck.startPeriod !== undefined && {
				startPeriod: definition.healthcheck.startPeriod,
			}),
		};
		const { command } = definition;
		const persist = entry.persist ?? DEFAULT_PERSIST_MODE;

		return ok({
			name: id,
			type: definition.id,
			containerName: serviceContainerName(stack.name, id),
			persist,
			definition,
			version,
			image: renderTemplate(definition.image, context),
			hostPort: hostPort.value,
			containerPort: definition.port.container,
			config,
			secrets,
			env: renderTemplateRecord(definition.env, context),
			exports: renderTemplateRecord(definition.exports, context),
			volumes:
				persist === "ephemeral"
					? []
					: definition.volumes.map((volume) => ({
							name: serviceVolumeName(stack.name, id, volume.name),
							source: volume.name,
							path: volume.path,
						})),
			dependsOn,
			healthcheck,
			...(command &&
				command.length > 0 && {
					command: renderTemplateList(command, context),
				}),
			...(seed.value !== undefined && { seed: seed.value }),
		});
	} catch (cause) {
		return templateFailure(service, cause);
	}
}
