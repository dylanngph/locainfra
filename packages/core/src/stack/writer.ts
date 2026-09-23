import { Document, isMap, type YAMLMap } from "yaml";
import type { FileStore } from "../ports/files.port";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import { decodeWithSchema, readYamlSource } from "../shared/yaml-schema";
import { parseStackFile, stackErrorToOpError } from "./loader";
import { StackError, type StackFile, StackServiceEntry } from "./stack.model";

/** First line of every stack file LocaInfra creates (editor schema hint). */
export const STACK_SCHEMA_COMMENT =
	"# yaml-language-server: $schema=https://locainfra.dev/schema/v1.json";

const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;
const ENTRY_FIELDS = ["version", "port", "config"] as const;

/** Serialisation options: never re-fold long scalars the user wrote. */
const TO_STRING = { lineWidth: 0 } as const;

/**
 * Renders a brand-new stack file with the schema hint comment.
 *
 * @param file - Stack contents.
 * @returns YAML text; services are written in flow style, one per line.
 */
export function renderStackFile(file: StackFile): string {
	const document = new Document({
		version: file.version,
		name: file.name,
		services: {},
		...(file.link === undefined ? {} : { link: file.link }),
	});
	document.commentBefore = STACK_SCHEMA_COMMENT.replace(/^#/, "");
	const services = document.get("services", true);
	if (isMap(services)) {
		for (const [id, entry] of Object.entries(file.services)) {
			services.set(id, entryNode(document, entry));
		}
	}
	return document.toString(TO_STRING);
}

function compactEntry(entry: StackServiceEntry): Record<string, unknown> {
	const compact: Record<string, unknown> = {};
	for (const field of ENTRY_FIELDS) {
		if (entry[field] !== undefined) compact[field] = entry[field];
	}
	return compact;
}

function entryNode(document: Document, entry: StackServiceEntry): YAMLMap {
	const node = document.createNode(compactEntry(entry)) as YAMLMap;
	node.flow = true;
	return node;
}

function validateEntry(
	id: string,
	entry: StackServiceEntry,
	filePath: string,
): Result<StackServiceEntry, StackError> {
	const issues: string[] = [];
	if (!SERVICE_ID.test(id)) {
		issues.push(
			`${filePath}: /services/${id}: service id must match ${SERVICE_ID.source}`,
		);
	}
	const decoded = decodeWithSchema(StackServiceEntry, compactEntry(entry));
	if (!decoded.ok) {
		for (const issue of decoded.error) {
			issues.push(
				`${filePath}: /services/${id}${issue.path}: ${issue.message}`,
			);
		}
	}
	if (issues.length > 0 || !decoded.ok) {
		return err(
			new StackError(`${filePath}: invalid entry for service "${id}"`, {
				filePath,
				issues,
			}),
		);
	}
	return ok(decoded.value);
}

type Mutation = (
	document: Document.Parsed,
	services: YAMLMap,
) => StackError | undefined;

function edit(
	text: string,
	filePath: string,
	mutate: Mutation,
): Result<string, StackError> {
	const before = parseStackFile(text, filePath);
	if (!before.ok) return before;
	const yaml = readYamlSource(text, filePath);
	if (!yaml.ok) {
		return err(
			new StackError(`${filePath}: invalid YAML`, {
				filePath,
				issues: yaml.error,
			}),
		);
	}
	const document = yaml.value.document;
	let services = document.get("services", true);
	if (!isMap(services)) {
		services = document.createNode({}) as YAMLMap;
		document.set("services", services);
	}
	const map = services as YAMLMap;
	if (map.flow && map.items.length === 0) map.flow = false;
	const failure = mutate(document, map);
	if (failure !== undefined) return err(failure);
	const next = document.toString(TO_STRING);
	const after = parseStackFile(next, filePath);
	if (!after.ok) return after;
	return ok(next);
}

/**
 * Adds a service entry, keeping every comment and the formatting of untouched
 * entries. The new entry is written in flow style (`id: { version: "17" }`).
 *
 * @param text - Current stack file text.
 * @param id - Catalog id (the `services` key).
 * @param entry - Entry fields; omitted fields fall back to catalog defaults.
 * @param filePath - Path used in messages.
 * @returns New text, or a {@link StackError} if the id exists or the result is invalid.
 */
export function addStackService(
	text: string,
	id: string,
	entry: StackServiceEntry,
	filePath = "locainfra.yaml",
): Result<string, StackError> {
	const valid = validateEntry(id, entry, filePath);
	if (!valid.ok) return valid;
	return edit(text, filePath, (document, services) => {
		if (services.has(id)) {
			return new StackError(`${filePath}: service "${id}" already exists`, {
				filePath,
				issues: [`${filePath}: /services/${id}: already exists`],
			});
		}
		services.set(id, entryNode(document, valid.value));
		return undefined;
	});
}

/**
 * Adds or updates a service entry. An existing entry is updated field by field
 * (fields absent from `entry` are removed), so comments around it survive.
 *
 * @param text - Current stack file text.
 * @param id - Catalog id.
 * @param entry - Complete desired entry.
 * @param filePath - Path used in messages.
 * @returns New text, or a {@link StackError} if the result is invalid.
 */
export function setStackService(
	text: string,
	id: string,
	entry: StackServiceEntry,
	filePath = "locainfra.yaml",
): Result<string, StackError> {
	const valid = validateEntry(id, entry, filePath);
	if (!valid.ok) return valid;
	return edit(text, filePath, (document, services) => {
		const existing = services.get(id, true);
		if (!isMap(existing)) {
			services.set(id, entryNode(document, valid.value));
			return undefined;
		}
		for (const field of ENTRY_FIELDS) {
			const value = valid.value[field];
			if (value === undefined) existing.delete(field);
			else existing.set(field, document.createNode(value));
		}
		return undefined;
	});
}

/**
 * Removes a service entry (and the comments attached to it); everything else
 * is kept verbatim.
 *
 * @param text - Current stack file text.
 * @param id - Catalog id.
 * @param filePath - Path used in messages.
 * @returns New text, or a {@link StackError} if the id is not present.
 */
export function removeStackService(
	text: string,
	id: string,
	filePath = "locainfra.yaml",
): Result<string, StackError> {
	return edit(text, filePath, (_document, services) => {
		if (!services.has(id)) {
			return new StackError(
				`${filePath}: service "${id}" is not in the stack`,
				{
					filePath,
					issues: [`${filePath}: /services/${id}: not found`],
				},
			);
		}
		services.delete(id);
		return undefined;
	});
}

/**
 * Applies a text edit to a stack file through the {@link FileStore} and writes
 * the result.
 *
 * @param files - File access.
 * @param filePath - Stack file path.
 * @param change - Pure edit, e.g. `(text) => addStackService(text, "redis", {}, filePath)`.
 * @param initial - Contents to start from when the file does not exist yet
 *   (e.g. {@link renderStackFile} of an empty stack); without it a missing file
 *   is `STACK_NOT_FOUND`.
 * @returns The validated new contents, or an `OpError` (`STACK_NOT_FOUND`, `IO`, `INVALID_STACK`).
 */
export async function updateStackFile(
	files: FileStore,
	filePath: string,
	change: (text: string) => Result<string, StackError>,
	initial?: string,
): Promise<Result<StackFile, OpError>> {
	let text: string | null;
	try {
		text = await files.readText(filePath);
	} catch (cause) {
		return err(
			new OpError("IO", `${filePath}: could not be read`, {
				details: { filePath },
				cause,
			}),
		);
	}
	const current = text ?? initial;
	if (current === undefined) {
		return err(
			new OpError("STACK_NOT_FOUND", `${filePath}: not found`, {
				details: { filePath },
			}),
		);
	}
	const next = change(current);
	if (!next.ok) return err(stackErrorToOpError(next.error));
	const parsed = parseStackFile(next.value, filePath);
	if (!parsed.ok) return err(stackErrorToOpError(parsed.error));
	try {
		await files.writeText(filePath, next.value);
	} catch (cause) {
		return err(
			new OpError("IO", `${filePath}: could not be written`, {
				details: { filePath },
				cause,
			}),
		);
	}
	return ok(parsed.value);
}
