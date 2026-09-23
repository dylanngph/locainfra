import type { ServiceDefinition } from "../catalog/catalog.model";
import { composeProjectName } from "../paths/layout";
import type { StateFile } from "../ports/state.port";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import type { Stack } from "../stack/stack.model";
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
	ResolvedService,
	ResolvedStack,
} from "./resolved.model";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Input of {@link resolveStack}. */
export interface ResolveStackInput {
	/** The stack to resolve. */
	readonly stack: Stack;
	/** The merged catalog. */
	readonly definitions: readonly ServiceDefinition[];
	/** Persisted state (pinned host ports). */
	readonly state: StateFile;
	/** The stack's secrets (never logged). */
	readonly secrets: Readonly<Record<string, string>>;
}

/**
 * Resolves a stack into concrete services: versions, host ports, config,
 * secrets, env, exports, volumes and healthchecks, with every `{{path}}`
 * template evaluated. Pure: no I/O.
 *
 * Host ports come from the stack file (`port: <n>`), else the pin in state,
 * else (global stack only) the definition's canonical default. Run
 * `allocatePorts` and `ensureSecrets` first when provisioning; a read-only
 * caller (e.g. `env`) gets `INVALID_STACK` for an unprovisioned stack.
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
		resolved.set(service.id, result.value);
	}

	const projectName = composeProjectName(input.stack.name);
	return ok({
		kind: input.stack.kind,
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
	const pinned = input.state.stacks[input.stack.name]?.ports[service.id];
	if (pinned !== undefined) return ok(pinned);
	if (input.stack.kind === "global") {
		return ok(service.definition.port.default);
	}
	return err(notProvisioned(input.stack, service.id, "host port"));
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
				fix: `Start the stack once (locainfra up${stack.kind === "global" ? " --global" : ""}) so ports and secrets are provisioned.`,
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
					service: service.id,
					catalogId: service.definition.id,
					paths,
					fix: "Fix the definition (catalog override or registry entry) or add the missing dependsOn.",
				},
			},
		),
	);
}

function resolveService(
	input: ResolveStackInput,
	service: PlannedService,
	resolved: ReadonlyMap<string, ResolvedService>,
): Result<ResolvedService> {
	const { stack } = input;
	const { definition, entry, id } = service;

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
		const value = input.secrets[name];
		if (value === undefined || value === "") {
			return err(notProvisioned(stack, id, `secret ${name}`));
		}
		secrets[name] = value;
	}

	const dependsOn = definition.dependsOn ?? [];
	const services: Record<string, TemplateServiceContext> = {};
	for (const dep of dependsOn) {
		const target = resolved.get(dep);
		if (target) {
			services[dep] = {
				port: target.hostPort,
				secrets: target.secrets,
				config: target.config,
			};
		}
	}

	try {
		const base: TemplateContext = {
			version,
			port: hostPort.value,
			stack: { name: stack.name },
			config: {},
			secrets,
			services,
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

		return ok({
			id,
			catalogId: definition.id,
			definition,
			version,
			image: renderTemplate(definition.image, context),
			hostPort: hostPort.value,
			containerPort: definition.port.container,
			config,
			secrets,
			env: renderTemplateRecord(definition.env, context),
			exports: renderTemplateRecord(definition.exports, context),
			volumes: definition.volumes.map((volume) => ({
				name: `${composeProjectName(stack.name)}-${id}-${volume.name}`,
				path: volume.path,
			})),
			dependsOn: [...dependsOn],
			healthcheck,
			...(command &&
				command.length > 0 && {
					command: renderTemplateList(command, context),
				}),
		});
	} catch (cause) {
		return templateFailure(service, cause);
	}
}
