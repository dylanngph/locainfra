import type { TSchema } from "@sinclair/typebox";

/** JSON Schema draft the published schemas conform to. */
export const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

function relaxDefaulted(node: JsonValue): JsonValue {
	if (Array.isArray(node)) return node.map(relaxDefaulted);
	if (node === null || typeof node !== "object") return node;
	const out: { [key: string]: JsonValue } = {};
	for (const [key, value] of Object.entries(node))
		out[key] = relaxDefaulted(value);
	const properties = out.properties;
	const required = out.required;
	if (
		Array.isArray(required) &&
		properties !== null &&
		typeof properties === "object" &&
		!Array.isArray(properties)
	) {
		const kept = required.filter((name) => {
			const property = typeof name === "string" ? properties[name] : undefined;
			return !(
				property !== null &&
				typeof property === "object" &&
				!Array.isArray(property) &&
				"default" in property
			);
		});
		if (kept.length > 0) out.required = kept;
		else delete out.required;
	}
	return out;
}

/**
 * Serialises a TypeBox schema as a published JSON Schema document.
 *
 * TypeBox schemas are JSON Schema already; this adds `$schema` and removes
 * properties that have a `default` from `required`, because loaders fill them
 * in (`Value.Parse` semantics) and editors should not demand them.
 *
 * @param schema - TypeBox schema (should carry an `$id`).
 * @returns Pretty-printed JSON with a trailing newline.
 */
export function publishedJsonSchema(schema: TSchema): string {
	const plain = JSON.parse(JSON.stringify(schema)) as JsonValue;
	const document = { $schema: JSON_SCHEMA_DRAFT, ...(plain as object) };
	return `${JSON.stringify(relaxDefaulted(document as JsonValue), null, "\t")}\n`;
}
