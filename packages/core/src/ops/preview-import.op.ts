import { slugName, uniqueName } from "../import/names";
import type { StateFile } from "../ports/state.port";
import { ioErrorFrom } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { mapComposeToCatalog } from "./map-compose-to-catalog.op";
import type { PreviewImport } from "./ops.contract";
import { parseComposeForImport } from "./parse-compose-for-import.op";
import { loadDefinitions } from "./support/catalog";

/** Base of the suggested project name when the caller gives none (or a taken one). */
export const DEFAULT_IMPORT_PROJECT_NAME = "compose-app";

/**
 * Import preview: {@link parseComposeForImport}, then
 * {@link mapComposeToCatalog} against every registered project's pinned
 * ports (labelled `<project>/<service>`) and a 127.0.0.1 probe, plus a free
 * `suggestedName`: `projectName` (a `.yml` extension dropped, made a valid
 * name) when it is not
 * registered, else `compose-app`, `compose-app-2`, …. Mutates nothing.
 * `INVALID_INPUT` from the parser, `INVALID_CATALOG`, `IO`.
 */
export const previewImport: PreviewImport = async (deps, input) => {
	const parsed = parseComposeForImport(input.yaml);
	if (!parsed.ok) return parsed;
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	let state: StateFile;
	try {
		state = await deps.state.read();
	} catch (cause) {
		return err(ioErrorFrom("Could not read LocaInfra state", cause));
	}
	const reserved = new Map<number, string>();
	for (const [stack, entry] of Object.entries(state.stacks)) {
		for (const [service, port] of Object.entries(entry.ports)) {
			if (!reserved.has(port)) reserved.set(port, `${stack}/${service}`);
		}
	}
	const plan = await mapComposeToCatalog({
		parsed: parsed.value,
		definitions: definitions.value,
		reserved,
		probe: deps.probe,
	});
	const registered = new Set(state.projects.map((p) => p.name));
	const wanted =
		input.projectName === undefined || input.projectName.trim() === ""
			? undefined
			: slugName(input.projectName.trim().replace(/\.ya?ml$/i, ""), "app");
	const suggestedName =
		wanted !== undefined && !registered.has(wanted)
			? wanted
			: uniqueName(DEFAULT_IMPORT_PROJECT_NAME, registered);
	return ok({ ...plan, suggestedName });
};
