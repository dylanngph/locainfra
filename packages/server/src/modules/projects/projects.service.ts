import { join } from "node:path";
import {
	PROJECT_STACK_FILE_NAME,
	type ProjectEntry,
	type ProjectStatus,
	type ProjectSummary,
	type Stack,
} from "@locainfra/core";
import type { ServerOps, ServerPorts } from "../../deps";
import type { OpAccepted } from "../../models/common.model";
import { checkProjectRoot } from "../../shared/project-root";
import { unwrap } from "../../shared/unwrap";
import type { ProjectUsage } from "../observer/observer.service";
import type { OpLauncher } from "../observer/op-registry";
import type {
	CreateProjectBody,
	PickedFolder,
	ProjectDetail,
} from "./projects.model";

/** Live CPU/MEM figures from the observer. */
export interface UsageSource {
	/** @returns Summed usage of the project's running containers, or `undefined` without fresh samples. */
	usageOf(project: string): ProjectUsage | undefined;
	/** @returns The status with per-row usage. */
	withUsage(status: ProjectStatus): ProjectStatus;
}

/** Ops used by {@link ProjectsService}. */
export type ProjectsOps = Pick<
	ServerOps,
	| "listProjects"
	| "registerProject"
	| "createProject"
	| "unregisterProject"
	| "loadProject"
	| "upProject"
	| "downProject"
	| "statusForProject"
>;

/**
 * Projects screen and project shell: registry, detail, Start all / Stop all.
 * No HTTP knowledge; failures are thrown `OpError`s.
 */
export class ProjectsService {
	/**
	 * @param ops - Core ops.
	 * @param ports - Ports passed to the ops.
	 * @param launcher - Starts long-running ops (`202 { opId }`).
	 * @param usage - Observer CPU/MEM overlay.
	 */
	constructor(
		private readonly ops: ProjectsOps,
		private readonly ports: ServerPorts,
		private readonly launcher: OpLauncher,
		private readonly usage: UsageSource,
	) {}

	/**
	 * @returns One summary per registered project, with CPU/MEM only when the
	 *   observer has fresh samples for it (left out otherwise).
	 */
	async list(): Promise<ProjectSummary[]> {
		const summaries = unwrap(await this.ops.listProjects(this.ports));
		return summaries.map((summary) =>
			summary.issue === undefined
				? { ...summary, ...this.usage.usageOf(summary.name) }
				: summary,
		);
	}

	/**
	 * Creates `<root>/locainfra.yaml` or, when the file exists, registers it
	 * as-is. A leading `~` in `root` means the home folder.
	 *
	 * The folder must be an existing directory, or a missing leaf whose parent
	 * is an existing directory (a typo such as `~/Develper/shop` is refused
	 * instead of creating a new tree). The home folder itself, its ancestors
	 * and hidden folders (any `.name` segment, e.g. `~/.ssh`) are refused:
	 * `locainfra.yaml` and later `.env` are written into the root, and a
	 * project at `~` would capture every folder below it.
	 *
	 * @param body - Name and folder.
	 * @returns The new project's summary.
	 * @throws OpError `INVALID_INPUT`, `PROJECT_EXISTS`, `INVALID_STACK`…
	 */
	async create(body: CreateProjectBody): Promise<ProjectSummary> {
		const root = await checkProjectRoot(body.root, this.ports);
		const exists = await this.ports.files.exists(
			join(root, PROJECT_STACK_FILE_NAME),
		);
		const entry: ProjectEntry = exists
			? unwrap(
					await this.ops.registerProject(this.ports, { name: body.name, root }),
				)
			: toEntry(
					unwrap(
						await this.ops.createProject(this.ports, { name: body.name, root }),
					),
				);
		const summaries = unwrap(await this.ops.listProjects(this.ports));
		return (
			summaries.find((s) => s.name === entry.name) ?? {
				name: entry.name,
				root: entry.root,
				...(entry.envFile === undefined ? {} : { envFile: entry.envFile }),
				serviceCount: 0,
				running: 0,
				errors: 0,
				types: [],
			}
		);
	}

	/**
	 * Opens the native folder dialog on this machine at `~/Developer`.
	 *
	 * @param name - Project name for the dialog title.
	 * @returns The chosen folder, or `null` when cancelled.
	 */
	async pickFolder(name: string | undefined): Promise<PickedFolder> {
		const root = await this.ports.folderPicker.pick({
			title:
				name === undefined || name === ""
					? "Choose a project folder"
					: `Choose a folder for ${name}`,
			defaultPath: join(this.ports.paths.home, "Developer"),
		});
		return { root };
	}

	/**
	 * @param project - Project name.
	 * @returns Stack file and live status.
	 * @throws OpError `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`, `INVALID_STACK`.
	 */
	async detail(project: string): Promise<ProjectDetail> {
		const stack = unwrap(await this.ops.loadProject(this.ports, { project }));
		const status = unwrap(
			await this.ops.statusForProject(this.ports, { project }),
		);
		return { stack, status: this.usage.withUsage(status) };
	}

	/**
	 * Unregisters a project (containers, volumes, secrets and files stay).
	 *
	 * @param project - Project name.
	 * @returns The removed registry entry.
	 * @throws OpError `PROJECT_NOT_FOUND`.
	 */
	async remove(project: string): Promise<ProjectEntry> {
		return unwrap(await this.ops.unregisterProject(this.ports, { project }));
	}

	/**
	 * Start all: checks the project loads, then runs `upProject` in the background.
	 *
	 * @param project - Project name.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`, `INVALID_STACK`.
	 */
	async up(project: string): Promise<OpAccepted> {
		unwrap(await this.ops.loadProject(this.ports, { project }));
		const opId = this.launcher.start({
			kind: "project.up",
			project,
			run: () => this.ops.upProject(this.ports, { project }),
		});
		return { opId };
	}

	/**
	 * Stop all: checks the project loads, then runs `downProject` in the background.
	 *
	 * @param project - Project name.
	 * @param volumes - Also delete named volumes.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`, `INVALID_STACK`.
	 */
	async down(project: string, volumes: boolean): Promise<OpAccepted> {
		unwrap(await this.ops.loadProject(this.ports, { project }));
		const opId = this.launcher.start({
			kind: "project.down",
			project,
			run: () => this.ops.downProject(this.ports, { project, volumes }),
		});
		return { opId };
	}
}

function toEntry(stack: Stack): ProjectEntry {
	return { name: stack.name, root: stack.root };
}
