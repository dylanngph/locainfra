import { join } from "node:path";
import {
	IMPORT_YAML_MAX_BYTES,
	type ImportPreview,
	OpError,
	PROJECT_STACK_FILE_NAME,
	type PreviewImportDeps,
	type StateReader,
} from "@locastack/core";
import type { ServerOps, ServerPorts } from "../../deps";
import type { OpAccepted } from "../../models/common.model";
import { checkProjectRoot } from "../../shared/project-root";
import { unwrap } from "../../shared/unwrap";
import type { OpLauncher } from "../observer/op-registry";
import type { ImportBody, ImportPreviewBody } from "./import.model";

/** Ops used by {@link ImportService}. */
export type ImportOps = Pick<ServerOps, "previewImport" | "importProject">;

/**
 * Import docker-compose.yml: a read-only preview of the pasted file mapped
 * onto the catalog, then the import itself as a long-running operation.
 */
export class ImportService {
	/**
	 * @param ops - Core ops.
	 * @param ports - Ports passed to the ops.
	 * @param launcher - Starts long-running ops.
	 */
	constructor(
		private readonly ops: ImportOps,
		private readonly ports: ServerPorts,
		private readonly launcher: OpLauncher,
	) {}

	/**
	 * Parses and maps the compose text. Writes nothing: the op receives only a
	 * read-only view of the state (no `update`), the catalog and the port
	 * probe, never the file store, secrets or Docker.
	 *
	 * @param body - Compose text and preferred project name.
	 * @returns The preview items and a free project name.
	 * @throws OpError `INVALID_INPUT` (invalid YAML, no services, over
	 * `IMPORT_YAML_MAX_BYTES` of UTF-8, checked here before the op since the
	 * body schema can only bound characters).
	 */
	async preview(body: ImportPreviewBody): Promise<ImportPreview> {
		if (Buffer.byteLength(body.yaml, "utf8") > IMPORT_YAML_MAX_BYTES)
			throw new OpError(
				"INVALID_INPUT",
				`The compose file is larger than ${IMPORT_YAML_MAX_BYTES / 1024} KB`,
				{ details: { field: "yaml", maxBytes: IMPORT_YAML_MAX_BYTES } },
			);
		const state: StateReader = { read: () => this.ports.state.read() };
		const deps: PreviewImportDeps = {
			state,
			catalog: this.ports.catalog,
			probe: this.ports.probe,
		};
		return unwrap(
			await this.ops.previewImport(deps, {
				yaml: body.yaml,
				...(body.projectName === undefined
					? {}
					: { projectName: body.projectName }),
			}),
		);
	}

	/**
	 * Creates the project from the reviewed preview (folder, `locastack.yaml`,
	 * secrets, registration, optional start) as a long-running operation.
	 * Pre-checks: the folder rules of New project, a free project name, no
	 * existing `locastack.yaml` in the folder, and at least one importable
	 * item with unique instance names.
	 *
	 * @param body - Name, folder, items and start flag.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_EXISTS`, `INVALID_INPUT`.
	 */
	async import(body: ImportBody): Promise<OpAccepted> {
		const root = await checkProjectRoot(body.root, this.ports);
		const state = await this.ports.state.read();
		if (state.projects.some((p) => p.name === body.name))
			throw new OpError(
				"PROJECT_EXISTS",
				`A project named ${body.name} is already registered`,
				{ details: { field: "name", fix: "Choose another project name" } },
			);
		if (await this.ports.files.exists(join(root, PROJECT_STACK_FILE_NAME)))
			throw new OpError(
				"PROJECT_EXISTS",
				`${root} already holds a ${PROJECT_STACK_FILE_NAME}`,
				{
					details: {
						field: "root",
						fix: "Pick an empty folder, or open the existing project",
					},
				},
			);
		const selected = body.items.filter((i) => i.supported && i.include);
		if (selected.length === 0)
			throw new OpError(
				"INVALID_INPUT",
				"Select at least one service to import",
				{
					details: { field: "items" },
				},
			);
		const seen = new Set<string>();
		for (const item of selected) {
			if (seen.has(item.name))
				throw new OpError(
					"INVALID_INPUT",
					`Two services would be named ${item.name}`,
					{ details: { field: "items", name: item.name } },
				);
			seen.add(item.name);
		}
		const opId = this.launcher.start({
			kind: "project.import",
			project: body.name,
			run: () =>
				this.ops.importProject(this.ports, {
					name: body.name,
					root,
					items: body.items,
					start: body.start,
				}),
		});
		return { opId };
	}
}
