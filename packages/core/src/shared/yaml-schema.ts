import type { Static, TSchema } from "@sinclair/typebox";
import { type ValueError, ValueErrorType } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import {
	type Document,
	isMap,
	isNode,
	isScalar,
	isSeq,
	LineCounter,
	parseDocument,
} from "yaml";
import { err, ok, type Result } from "./result";

/** A validation problem located by JSON pointer (e.g. `/port/container`). */
export interface SchemaIssue {
	/** JSON pointer into the document; `""` is the root. */
	readonly path: string;
	/** Human-readable message (never contains document values). */
	readonly message: string;
}

/** A parsed YAML document with the bookkeeping needed for friendly errors. */
export interface YamlSource {
	/** Where the text came from (file path or URL), used as the message prefix. */
	readonly source: string;
	/** The yaml `Document` (keeps comments; use it for round-trip edits). */
	readonly document: Document.Parsed;
	/** Maps offsets in the text to line/column. */
	readonly lineCounter: LineCounter;
	/** Plain JS value of the document (`null` when empty). */
	readonly data: unknown;
}

/**
 * Parses YAML text with the Document API (comments preserved).
 *
 * @param text - YAML text.
 * @param source - File path or URL for messages.
 * @returns The parsed document, or `source:line:col: message` strings for syntax errors.
 */
export function readYamlSource(
	text: string,
	source: string,
): Result<YamlSource, string[]> {
	const lineCounter = new LineCounter();
	const document = parseDocument(text, { lineCounter, uniqueKeys: true });
	if (document.errors.length > 0) {
		return err(
			document.errors.map((error) => {
				const firstLine = (error.message.split("\n")[0] ?? "").replace(
					/ at line \d+, column \d+:?$/,
					"",
				);
				const pos = error.linePos?.[0] ?? lineCounter.linePos(error.pos[0]);
				return `${source}:${pos.line}:${pos.col}: ${firstLine}`;
			}),
		);
	}
	let data: unknown;
	try {
		data = document.toJS({ maxAliasCount: 100 });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return err([`${source}: ${message}`]);
	}
	return ok({ source, document, lineCounter, data: data ?? null });
}

function pointerSegments(pointer: string): string[] {
	if (pointer === "") return [];
	return pointer
		.split("/")
		.slice(1)
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The node a path points at: the key node for map entries, else the item. */
function nodeAt(yaml: YamlSource, segments: readonly string[]): unknown {
	if (segments.length === 0) return yaml.document.contents;
	const parent = valueAt(yaml, segments.slice(0, -1));
	const last = segments[segments.length - 1];
	if (isMap(parent)) {
		const pair = parent.items.find(
			(item) => isScalar(item.key) && String(item.key.value) === last,
		);
		return pair?.key ?? null;
	}
	if (isSeq(parent)) return parent.items[Number(last)] ?? null;
	return null;
}

function valueAt(yaml: YamlSource, segments: readonly string[]): unknown {
	return segments.length === 0
		? yaml.document.contents
		: yaml.document.getIn(segments, true);
}

function locate(yaml: YamlSource, pointer: string): string {
	const segments = pointerSegments(pointer);
	for (let depth = segments.length; depth >= 0; depth--) {
		const prefix = segments.slice(0, depth);
		for (const node of [nodeAt(yaml, prefix), valueAt(yaml, prefix)]) {
			if (isNode(node) && node.range) {
				const pos = yaml.lineCounter.linePos(node.range[0]);
				return `${yaml.source}:${pos.line}:${pos.col}`;
			}
		}
	}
	return yaml.source;
}

/**
 * Formats issues as `source:line:col: /pointer: message`.
 *
 * @param yaml - The document the issues refer to.
 * @param issues - Pointer-located issues.
 * @returns One line per issue.
 */
export function formatIssues(
	yaml: YamlSource,
	issues: readonly SchemaIssue[],
): string[] {
	return issues.map(
		(issue) =>
			`${locate(yaml, issue.path)}: ${issue.path || "/"}: ${issue.message}`,
	);
}

function describeMember(schema: TSchema): string {
	if ("const" in schema) return JSON.stringify(schema.const);
	if (typeof schema.type === "string") return schema.type;
	return "value";
}

function friendlyMessage(error: ValueError): string {
	const schema = error.schema;
	switch (error.type) {
		case ValueErrorType.ObjectRequiredProperty:
			return "is required";
		case ValueErrorType.ObjectAdditionalProperties: {
			const patterns = Object.keys(schema.patternProperties ?? {});
			return patterns.length > 0
				? `invalid key; keys must match ${patterns.join(" or ")}`
				: "unknown property";
		}
		case ValueErrorType.Union: {
			const members = (schema.anyOf ?? []) as TSchema[];
			return `must be one of: ${members.map(describeMember).join(", ")}`;
		}
		case ValueErrorType.Literal:
			return `must be ${JSON.stringify(schema.const)}`;
		case ValueErrorType.StringPattern:
			return `must match ${String(schema.pattern)}`;
		case ValueErrorType.ArrayMinItems:
			return `must have at least ${String(schema.minItems)} item(s)`;
		default:
			return error.message.charAt(0).toLowerCase() + error.message.slice(1);
	}
}

/**
 * Lists schema violations of `value`, one per JSON pointer (first wins).
 *
 * @param schema - TypeBox schema.
 * @param value - Candidate value (already defaulted/converted).
 * @returns Friendly issues; empty when valid.
 */
export function schemaIssues(schema: TSchema, value: unknown): SchemaIssue[] {
	const seen = new Set<string>();
	const issues: SchemaIssue[] = [];
	for (const error of Value.Errors(schema, value)) {
		if (seen.has(error.path)) continue;
		seen.add(error.path);
		issues.push({ path: error.path, message: friendlyMessage(error) });
	}
	return issues;
}

/**
 * Validates a plain value against a TypeBox schema with `Value.Parse`
 * semantics, but without silently dropping invalid record keys.
 *
 * Pipeline: Clone → Default → Convert → check (issues) → Clean. `Clean` runs
 * last because running it first (as `Value.Parse` does) would delete keys that
 * violate a record's key pattern instead of reporting them.
 *
 * @param schema - TypeBox schema.
 * @param raw - Untrusted value (e.g. from YAML).
 * @returns The parsed value, or pointer-located issues.
 */
export function decodeWithSchema<S extends TSchema>(
	schema: S,
	raw: unknown,
): Result<Static<S>, SchemaIssue[]> {
	if (raw === null || raw === undefined) {
		return err([
			{ path: "", message: "document is empty; expected a mapping" },
		]);
	}
	const candidate = Value.Parse(["Clone", "Default", "Convert"], schema, raw);
	const issues = schemaIssues(schema, candidate);
	if (issues.length > 0) return err(issues);
	return ok(Value.Clean(schema, candidate) as Static<S>);
}
