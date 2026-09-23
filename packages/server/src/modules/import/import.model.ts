import {
	IMPORT_MAX_SERVICES,
	IMPORT_YAML_MAX_BYTES,
	ImportItem,
	ImportPreview,
	ResourceName,
} from "@locainfra/core";
import { t } from "elysia";

/** `POST /api/import/preview` body: compose text pasted or dropped in the dashboard. */
export const ImportPreviewBody = t.Object({
	yaml: t.String({
		minLength: 1,
		maxLength: IMPORT_YAML_MAX_BYTES,
		description: "docker-compose.yml contents",
	}),
	projectName: t.Optional(
		t.String({
			maxLength: 64,
			description:
				"Preferred project name (e.g. derived from the file name); used as suggestedName when valid and free",
		}),
	),
});
/** `POST /api/import/preview` body. */
export type ImportPreviewBody = typeof ImportPreviewBody.static;

/** `POST /api/import` body: the reviewed preview. */
export const ImportBody = t.Object({
	name: ResourceName,
	root: t.String({
		minLength: 1,
		description:
			"Absolute project folder (created when missing; must not hold a locainfra.yaml)",
	}),
	items: t.Array(ImportItem, {
		minItems: 1,
		maxItems: IMPORT_MAX_SERVICES,
		description:
			"Preview items as returned (include toggled by the user); only supported && include ones are imported",
	}),
	start: t.Boolean({ description: "Start the imported services afterwards" }),
});
/** `POST /api/import` body. */
export type ImportBody = typeof ImportBody.static;

/** Reference models of the import controller, registered under `Import.`. */
export const ImportModel = {
	previewBody: ImportPreviewBody,
	preview: ImportPreview,
	body: ImportBody,
};
