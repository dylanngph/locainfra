import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { EnvModel } from "./env.model";
import type { EnvService } from "./env.service";

const TAGS = ["Environment"];

/**
 * Environment controller (routes only).
 *
 * @param service - Env preview/writer.
 * @returns The `/api/projects/:project/env` routes.
 */
export const envModule = (service: EnvService) =>
	new Elysia({ name: "Env.Controller", prefix: "/api/projects/:project/env" })
		.model(EnvModel)
		.prefix("model", "Env.")
		.use(commonModels)
		.get("/", ({ params, query }) => service.preview(params.project, query), {
			params: "Common.ProjectParams",
			query: "Env.Query",
			response: {
				200: "Env.Preview",
				404: "Common.Error",
				422: "Common.Error",
			},
			detail: {
				tags: TAGS,
				summary: "Preview the project's exported variables",
			},
		})
		.post("/write", ({ params, body }) => service.write(params.project, body), {
			params: "Common.ProjectParams",
			body: "Env.Write",
			response: {
				200: "Env.Written",
				404: "Common.Error",
				422: "Common.Error",
			},
			detail: {
				tags: TAGS,
				summary:
					"Write the variables into the env file's locastack marker block",
			},
		});
