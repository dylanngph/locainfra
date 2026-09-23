import type { PersistMode, StackServiceEntry } from "@locainfra/server";
import { parse, stringify } from "yaml";

/** Result of parsing the YAML side editor. */
export type ParsedEntry =
	| {
			readonly ok: true;
			readonly name: string;
			readonly version?: string;
			readonly port?: string;
			readonly persist?: PersistMode;
			readonly config?: Record<string, string>;
			readonly seed?: string;
	  }
	| { readonly ok: false; readonly error: string };

/**
 * Renders one instance as the `services:` block of `locainfra.yaml`.
 *
 * @param name - Instance name (`unnamed` when empty).
 * @param entry - Stack entry.
 * @returns YAML text.
 */
export function entryToYaml(name: string, entry: StackServiceEntry): string {
	return stringify(
		{ services: { [name || "unnamed"]: entry } },
		{ lineWidth: 0 },
	);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the side editor back into form fields. `type` is fixed by the page,
 * so a different `type` is reported as an error rather than applied.
 *
 * @param text - Editor contents.
 * @param type - Catalog id the page is configuring.
 * @returns Parsed fields or an error message.
 */
export function yamlToEntry(text: string, type: string): ParsedEntry {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? (error.message.split("\n")[0] ?? "Invalid YAML")
					: "Invalid YAML",
		};
	}
	if (!isRecord(doc) || !isRecord(doc.services))
		return { ok: false, error: "Expected a services: map." };
	const names = Object.keys(doc.services);
	if (names.length !== 1)
		return { ok: false, error: "Describe exactly one service here." };
	const name = names[0] ?? "";
	const entry = doc.services[name];
	if (!isRecord(entry))
		return { ok: false, error: `services.${name} must be a map.` };
	if (entry.type !== undefined && entry.type !== type)
		return { ok: false, error: `type is ${type} on this page.` };
	if (
		entry.persist !== undefined &&
		entry.persist !== "volume" &&
		entry.persist !== "ephemeral"
	)
		return { ok: false, error: "persist must be volume or ephemeral." };
	if (entry.config !== undefined && !isRecord(entry.config))
		return { ok: false, error: "config must be a map." };
	if (entry.seed !== undefined && typeof entry.seed !== "string")
		return { ok: false, error: "seed must be a file path." };
	const config = isRecord(entry.config)
		? Object.fromEntries(
				Object.entries(entry.config).map(([k, v]) => [k, String(v ?? "")]),
			)
		: undefined;
	return {
		ok: true,
		name: name === "unnamed" ? "" : name,
		...(entry.version === undefined ? {} : { version: String(entry.version) }),
		...(entry.port === undefined ? {} : { port: String(entry.port) }),
		...(entry.persist === undefined ? {} : { persist: entry.persist }),
		...(config ? { config } : {}),
		...(typeof entry.seed === "string" ? { seed: entry.seed } : {}),
	};
}
