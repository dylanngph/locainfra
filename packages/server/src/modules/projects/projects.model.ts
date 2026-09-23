import {
	ProjectEntry,
	ProjectStatus,
	ProjectSummary,
	ResourceName,
	Stack,
} from "@locainfra/core";
import { t } from "elysia";

/** `POST /api/projects` body: a new or existing project folder. */
export const CreateProjectBody = t.Object({
	name: ResourceName,
	root: t.String({
		minLength: 1,
		description:
			"Absolute folder. Created with a fresh locainfra.yaml when it has none; an existing locainfra.yaml is registered as-is (its name must match)",
	}),
});
/** `POST /api/projects` body. */
export type CreateProjectBody = typeof CreateProjectBody.static;

/** `POST /api/projects/pick-folder` body. */
export const PickFolderBody = t.Object({
	name: t.Optional(
		t.String({
			description:
				"Project name, used for the dialog title and the default folder ~/Developer/<name>",
		}),
	),
});
/** `POST /api/projects/pick-folder` body. */
export type PickFolderBody = typeof PickFolderBody.static;

/** `POST /api/projects/pick-folder` response. */
export const PickedFolder = t.Object({
	root: t.Union([t.String(), t.Null()], {
		description: "Chosen absolute folder; null when cancelled or unsupported",
	}),
});
/** `POST /api/projects/pick-folder` response. */
export type PickedFolder = typeof PickedFolder.static;

/** `GET /api/projects/:project` response: the stack file plus live status. */
export const ProjectDetail = t.Object({
	stack: Stack,
	status: ProjectStatus,
});
/** `GET /api/projects/:project` response. */
export type ProjectDetail = typeof ProjectDetail.static;

/** `POST /api/projects/:project/down` query. */
export const DownQuery = t.Object({
	volumes: t.Optional(
		t.Boolean({
			description:
				"Also delete named volumes (destructive; the UI asks for typed confirmation)",
		}),
	),
});
/** `POST /api/projects/:project/down` query. */
export type DownQuery = typeof DownQuery.static;

/** Reference models of the projects controller, registered under `Projects.`. */
export const ProjectsModel = {
	list: t.Array(ProjectSummary),
	summary: ProjectSummary,
	entry: ProjectEntry,
	create: CreateProjectBody,
	pickFolder: PickFolderBody,
	pickedFolder: PickedFolder,
	detail: ProjectDetail,
	downQuery: DownQuery,
};
