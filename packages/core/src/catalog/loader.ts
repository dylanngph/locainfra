import type { FileStore } from "../ports/files.port";
import { err, ok, type Result } from "../shared/result";
import {
	decodeWithSchema,
	formatIssues,
	readYamlSource,
} from "../shared/yaml-schema";
import { CatalogError, ServiceDefinition } from "./catalog.model";
import {
	checkDefinitionConsistency,
	checkDefinitionSafety,
	type SafetyOptions,
} from "./validator";

/** Options of {@link parseServiceDefinition} and {@link loadServiceDefinition}. */
export interface LoadDefinitionOptions extends SafetyOptions {
	/**
	 * Expected `id` (e.g. derived from the file name `postgres.yaml`); a
	 * mismatch is reported as an issue. Omit to accept any id.
	 */
	readonly expectedId?: string;
}

function rawId(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const id = (data as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/**
 * Parses and validates one catalog definition from YAML text.
 *
 * Runs YAML syntax checks, the {@link ServiceDefinition} schema (with defaults
 * and scalar conversion), the safety rules and the consistency rules, and
 * reports every problem at once as `source:line:col: /pointer: message`.
 *
 * @param text - YAML text of the definition.
 * @param source - File path or URL, used in messages.
 * @param options - Registry allow-list and expected id.
 * @returns The definition, or a {@link CatalogError} whose `issues` list every problem.
 */
export function parseServiceDefinition(
	text: string,
	source: string,
	options: LoadDefinitionOptions = {},
): Result<ServiceDefinition, CatalogError> {
	const yaml = readYamlSource(text, source);
	if (!yaml.ok) {
		return err(
			new CatalogError(`${source}: invalid YAML`, {
				source,
				issues: yaml.error,
			}),
		);
	}
	const catalogId = rawId(yaml.value.data) ?? options.expectedId;
	const safety = checkDefinitionSafety(yaml.value.data, options);
	const decoded = decodeWithSchema(ServiceDefinition, yaml.value.data);
	const issues = [
		...safety,
		...(decoded.ok ? checkDefinitionConsistency(decoded.value) : decoded.error),
	];
	if (
		options.expectedId !== undefined &&
		decoded.ok &&
		decoded.value.id !== options.expectedId
	) {
		issues.push({
			path: "/id",
			message: `must be "${options.expectedId}" to match the file name`,
		});
	}
	if (issues.length > 0 || !decoded.ok) {
		const lines = formatIssues(yaml.value, issues);
		return err(
			new CatalogError(
				`${source}: invalid service definition${catalogId ? ` "${catalogId}"` : ""} (${lines.length} issue${lines.length === 1 ? "" : "s"})`,
				{ catalogId, source, issues: lines },
			),
		);
	}
	return ok(decoded.value);
}

/**
 * Reads and validates one catalog definition through the {@link FileStore}.
 *
 * @param files - File access.
 * @param path - Definition file path.
 * @param options - Registry allow-list and expected id.
 * @returns The definition, or a {@link CatalogError} (missing file, I/O failure or invalid content).
 */
export async function loadServiceDefinition(
	files: FileStore,
	path: string,
	options: LoadDefinitionOptions = {},
): Promise<Result<ServiceDefinition, CatalogError>> {
	let text: string | null;
	try {
		text = await files.readText(path);
	} catch (cause) {
		return err(
			new CatalogError(`${path}: could not be read`, {
				source: path,
				catalogId: options.expectedId,
				cause,
			}),
		);
	}
	if (text === null) {
		return err(
			new CatalogError(`${path}: not found`, {
				source: path,
				catalogId: options.expectedId,
			}),
		);
	}
	return parseServiceDefinition(text, path, options);
}
