import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { ProjectsModel } from "./projects.model";
import type { ProjectsService } from "./projects.service";

const TAGS = ["Projects"];

/**
 * Projects controller (routes only).
 *
 * @param service - Projects use-cases.
 * @returns The `/api/projects` routes.
 */
export const projectsModule = (service: ProjectsService) =>
	new Elysia({ name: "Projects.Controller", prefix: "/api/projects" })
		.model(ProjectsModel)
		.prefix("model", "Projects.")
		.use(commonModels)
		.get("/", () => service.list(), {
			response: { 200: "Projects.List", 500: "Common.Error" },
			detail: {
				tags: TAGS,
				summary: "List registered projects with live summaries",
			},
		})
		.post(
			"/",
			async ({ body, status }) => status(201, await service.create(body)),
			{
				body: "Projects.Create",
				response: {
					201: "Projects.Summary",
					404: "Common.Error",
					409: "Common.Error",
					422: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary:
						"Create a project folder with locastack.yaml, or register an existing one",
				},
			},
		)
		.post("/pick-folder", ({ body }) => service.pickFolder(body.name), {
			body: "Projects.PickFolder",
			response: { 200: "Projects.PickedFolder" },
			detail: {
				tags: TAGS,
				summary: "Open the native folder picker on this machine",
			},
		})
		.get("/:project", ({ params }) => service.detail(params.project), {
			params: "Common.ProjectParams",
			response: {
				200: "Projects.Detail",
				404: "Common.Error",
				422: "Common.Error",
			},
			detail: {
				tags: TAGS,
				summary: "Stack file and live status of a project",
			},
		})
		.delete("/:project", ({ params }) => service.remove(params.project), {
			params: "Common.ProjectParams",
			response: {
				200: "Projects.Entry",
				404: "Common.Error",
			},
			detail: {
				tags: TAGS,
				summary:
					"Unregister a project (containers, volumes and files are kept)",
			},
		})
		.post(
			"/:project/up",
			async ({ params, status }) =>
				status(202, await service.up(params.project)),
			{
				params: "Common.ProjectParams",
				response: {
					202: "Common.OpAccepted",
					404: "Common.Error",
					422: "Common.Error",
				},
				detail: { tags: TAGS, summary: "Start all services (Start all)" },
			},
		)
		.post(
			"/:project/down",
			async ({ params, query, status }) =>
				status(202, await service.down(params.project, query.volumes === true)),
			{
				params: "Common.ProjectParams",
				query: "Projects.DownQuery",
				response: {
					202: "Common.OpAccepted",
					404: "Common.Error",
					422: "Common.Error",
				},
				detail: { tags: TAGS, summary: "Stop all services (Stop all)" },
			},
		);
