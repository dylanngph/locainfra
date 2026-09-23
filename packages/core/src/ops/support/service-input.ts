import type { ServiceDefinition } from "../../catalog/catalog.model";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import {
	NAME_PATTERN,
	type PersistMode,
	SEED_PATH_PATTERN,
	type Stack,
	type StackServiceEntry,
} from "../../stack/stack.model";
import { SECRET_VALUE_PATTERN } from "../ops.model";

const NAME = new RegExp(NAME_PATTERN);
const SEED_PATH = new RegExp(SEED_PATH_PATTERN, "u");
const SECRET_VALUE = new RegExp(SECRET_VALUE_PATTERN);

/** Entry fields a caller may set on a service instance. */
export interface ServiceFields {
	/** Version (must be one of the definition's `versions`). */
	readonly version?: string;
	/** Host port or `auto`. */
	readonly port?: number | "auto";
	/** Persistence mode. */
	readonly persist?: PersistMode;
	/** Config overrides (keys must be the definition's `config` keys). */
	readonly config?: Readonly<Record<string, string>>;
	/**
	 * Seed file relative to the project root (definitions with a `seed`
	 * block only); `""` means none (a patch removes it).
	 */
	readonly seed?: string;
}

function invalid(message: string, details: Record<string, unknown>) {
	return err(new OpError("INVALID_INPUT", message, { details }));
}

/**
 * @param name - Project or service instance name.
 * @param what - `project` or `service`, used in the message.
 * @returns `ok`, or `INVALID_INPUT` when `name` does not match `NAME_PATTERN`.
 */
export function checkName(
	name: string,
	what: "project" | "service",
): Result<void> {
	if (NAME.test(name)) return ok(undefined);
	return invalid(`Invalid ${what} name "${name}"`, {
		name,
		fix: "Use lowercase letters, digits and dashes, starting with a letter (e.g. main-db).",
	});
}

/**
 * @param definitions - The merged catalog.
 * @param type - Catalog id.
 * @returns The definition, or `INVALID_INPUT` for an unknown type.
 */
export function findDefinition(
	definitions: readonly ServiceDefinition[],
	type: string,
): Result<ServiceDefinition> {
	const definition = definitions.find((d) => d.id === type);
	if (definition !== undefined) return ok(definition);
	return invalid(`Unknown service type "${type}"`, {
		type,
		fix: `Pick one of: ${definitions.map((d) => d.id).join(", ")}.`,
	});
}

/**
 * Validates entry fields against a catalog definition: version in
 * `versions`, port in 1–65535, config keys known and matching their
 * `pattern`.
 *
 * @param definition - The service's definition.
 * @param fields - Fields to check.
 * @returns `ok`, or `INVALID_INPUT` naming the first problem.
 */
export function checkServiceFields(
	definition: ServiceDefinition,
	fields: ServiceFields,
): Result<void> {
	if (
		fields.version !== undefined &&
		!definition.versions.includes(fields.version)
	) {
		return invalid(
			`Version "${fields.version}" is not available for ${definition.name}`,
			{
				version: fields.version,
				fix: `Pick one of: ${definition.versions.join(", ")}.`,
			},
		);
	}
	if (
		typeof fields.port === "number" &&
		(!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535)
	) {
		return invalid(`Port ${fields.port} is not a valid port`, {
			port: fields.port,
			fix: "Use a port between 1 and 65535, or auto.",
		});
	}
	for (const [key, value] of Object.entries(fields.config ?? {})) {
		const known = definition.config[key];
		if (known === undefined) {
			return invalid(`Unknown config "${key}" for ${definition.name}`, {
				key,
				fix: `Known config keys: ${Object.keys(definition.config).join(", ") || "none"}.`,
			});
		}
		if (known.pattern !== undefined && !new RegExp(known.pattern).test(value)) {
			return invalid(`config.${key} must match ${known.pattern}`, {
				key,
				pattern: known.pattern,
				fix: `Use a value matching ${known.pattern}.`,
			});
		}
	}
	if (fields.seed !== undefined && fields.seed !== "") {
		if (definition.seed === undefined) {
			return invalid(`${definition.name} does not support seed files`, {
				fix: "Remove the seed file, or load data with the service's own client.",
			});
		}
		if (fields.seed.length > 1024 || !SEED_PATH.test(fields.seed)) {
			return invalid(
				`Seed file "${fields.seed}" must be a path inside the project folder`,
				{
					fix: "Use a relative path like db/seed.sql (no leading /, ~, drive letter or ..).",
				},
			);
		}
	}
	return ok(undefined);
}

/**
 * Validates client-chosen initial secrets (Config page "Regenerate"): every
 * name is an entry of the definition's `secrets` and every value matches
 * `SECRET_VALUE_PATTERN`. Messages never contain the values.
 *
 * @param definition - The service's definition.
 * @param secrets - Secret name → value.
 * @returns `ok`, or `INVALID_INPUT` naming the first bad secret.
 */
export function checkSecretValues(
	definition: ServiceDefinition,
	secrets: Readonly<Record<string, string>> | undefined,
): Result<void> {
	for (const [name, value] of Object.entries(secrets ?? {})) {
		if (!definition.secrets.includes(name)) {
			return invalid(`Unknown secret "${name}" for ${definition.name}`, {
				key: name,
				fix: `Known secrets: ${definition.secrets.join(", ") || "none"}.`,
			});
		}
		if (!SECRET_VALUE.test(value)) {
			return invalid(`The value of ${name} is not a valid secret`, {
				key: name,
				pattern: SECRET_VALUE_PATTERN,
				fix: "Use 16-256 characters from A-Z a-z 0-9 . _ ~ - (or let LocaInfra generate it).",
			});
		}
	}
	return ok(undefined);
}

/**
 * Builds a compact stack entry: only fields that are set (`port: auto` is
 * written as is when given).
 *
 * @param type - Catalog id.
 * @param fields - Optional fields.
 * @param uses - Existing `uses` to keep.
 * @returns The entry.
 */
export function buildEntry(
	type: string,
	fields: ServiceFields,
	uses?: StackServiceEntry["uses"],
): StackServiceEntry {
	return {
		type,
		...(fields.version !== undefined && { version: fields.version }),
		...(fields.port !== undefined && { port: fields.port }),
		...(fields.persist !== undefined && { persist: fields.persist }),
		...(fields.config !== undefined &&
			Object.keys(fields.config).length > 0 && {
				config: { ...fields.config },
			}),
		...(fields.seed !== undefined &&
			fields.seed !== "" && { seed: fields.seed }),
		...(uses !== undefined && { uses }),
	};
}

/**
 * @param stack - The project stack.
 * @param name - Service instance name.
 * @returns The entry, or `SERVICE_NOT_FOUND`.
 */
export function findService(
	stack: Stack,
	name: string,
): Result<StackServiceEntry> {
	const entry = Object.hasOwn(stack.file.services, name)
		? stack.file.services[name]
		: undefined;
	if (entry !== undefined) return ok(entry);
	return err(
		new OpError(
			"SERVICE_NOT_FOUND",
			`Project "${stack.name}" has no service "${name}"`,
			{ details: { project: stack.name, service: name } },
		),
	);
}

/**
 * @param stack - The project stack.
 * @param definitions - The merged catalog.
 * @param name - Service instance name.
 * @returns Names of the services whose `dependsOn` is bound to `name`
 *   (their `uses`, else the first instance of the type, as in `planStack`).
 */
export function dependentsOf(
	stack: Stack,
	definitions: readonly ServiceDefinition[],
	name: string,
): string[] {
	const target = stack.file.services[name];
	if (target === undefined) return [];
	const byId = new Map(definitions.map((d) => [d.id, d]));
	const services = Object.entries(stack.file.services);
	const dependents: string[] = [];
	for (const [other, entry] of services) {
		if (other === name) continue;
		for (const dep of byId.get(entry.type)?.dependsOn ?? []) {
			if (dep !== target.type) continue;
			const bound =
				entry.uses?.[dep] ??
				services.find(([n, e]) => n !== other && e.type === dep)?.[0];
			if (bound === name) dependents.push(other);
		}
	}
	return dependents;
}
