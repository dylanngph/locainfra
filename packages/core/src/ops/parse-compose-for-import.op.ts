import { parseDocument } from "yaml";
import {
	hasBuild,
	isRecord,
	parseEnvironment,
	parsePorts,
} from "../import/compose-fields";
import { OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import type { ParseComposeForImport } from "./ops.contract";
import {
	type ComposeImportService,
	IMPORT_MAX_SERVICES,
	IMPORT_YAML_MAX_BYTES,
} from "./ops.model";

/** Most YAML aliases expanded while parsing (guards against alias bombs). */
const MAX_ALIAS_COUNT = 100;

/** Message when the file has no usable top-level `services` map. */
export const NO_SERVICES_MESSAGE =
	"No services found. Make sure the file has a top-level “services:” key.";

function invalid(message: string, fix?: string) {
	return err(
		new OpError("INVALID_INPUT", message, {
			...(fix !== undefined && { details: { fix } }),
		}),
	);
}

/**
 * Parses docker-compose YAML (with the `yaml` package; merge keys and
 * anchors allowed) into the fields Import needs: per service, in file
 * order, its image, whether it builds from source, its TCP port mappings
 * (short and long syntax; ranges and interpolated ports skipped) and its
 * environment (list or map form; `${VAR:-default}` keeps its default,
 * other interpolated values are left out). Pure.
 *
 * `INVALID_INPUT` for text over `IMPORT_YAML_MAX_BYTES`, invalid YAML
 * (message with line and column), no top-level `services` map
 * ({@link NO_SERVICES_MESSAGE}) or more than `IMPORT_MAX_SERVICES` services.
 */
export const parseComposeForImport: ParseComposeForImport = (yamlText) => {
	if (Buffer.byteLength(yamlText, "utf8") > IMPORT_YAML_MAX_BYTES) {
		return invalid(
			`The file is larger than ${IMPORT_YAML_MAX_BYTES / 1024} KB.`,
			"Import a docker-compose.yml, not a bundle of files.",
		);
	}
	const doc = parseDocument(yamlText, { merge: true, prettyErrors: true });
	const [first] = doc.errors;
	if (first !== undefined) {
		const pos = first.linePos?.[0];
		const text = (first.message.split("\n")[0] ?? "").replace(
			/ at line \d+, column \d+:?$/,
			"",
		);
		return invalid(
			pos === undefined
				? `Invalid YAML: ${text}`
				: `Invalid YAML at line ${pos.line}, column ${pos.col}: ${text}`,
			"Fix the YAML (or paste the file again), then retry.",
		);
	}
	let root: unknown;
	try {
		root = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
	} catch (cause) {
		return invalid(
			`Invalid YAML: ${cause instanceof Error ? cause.message : "could not be read"}`,
		);
	}
	const services = isRecord(root) ? root.services : undefined;
	if (!isRecord(services) || Object.keys(services).length === 0) {
		return invalid(NO_SERVICES_MESSAGE);
	}
	const entries = Object.entries(services);
	if (entries.length > IMPORT_MAX_SERVICES) {
		return invalid(
			`The file has ${entries.length} services; Import takes at most ${IMPORT_MAX_SERVICES}.`,
		);
	}
	return ok({
		services: entries.map(([name, raw]): ComposeImportService => {
			const spec = isRecord(raw) ? raw : {};
			const image =
				typeof spec.image === "string" && spec.image.trim() !== ""
					? spec.image.trim()
					: undefined;
			return {
				name,
				...(image !== undefined && { image }),
				build: hasBuild(spec.build),
				ports: parsePorts(spec.ports),
				environment: parseEnvironment(spec.environment),
			};
		}),
	});
};
