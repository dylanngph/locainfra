import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { DataModel } from "./data.model";
import type { DataService } from "./data.service";

const TAGS = ["Data"];

/** Failures shared by both Data tab routes. */
const ERRORS = {
	404: "Common.Error",
	409: "Common.Error",
	422: "Common.Error",
	504: "Common.Error",
} as const;

/**
 * Data tab controller (routes only): the query runner of one service
 * instance. One-shot REST; nothing streams or polls.
 *
 * @param service - Data tab use-cases.
 * @returns The `/api/projects/:project/services/:name/data` routes.
 */
export const dataModule = (service: DataService) =>
	new Elysia({
		name: "Data.Controller",
		prefix: "/api/projects/:project/services/:name/data",
	})
		.model(DataModel)
		.prefix("model", "Data.")
		.use(commonModels)
		.get("/", ({ params }) => service.objects(params.project, params.name), {
			params: "Common.ServiceParams",
			response: { 200: "Data.Objects", ...ERRORS },
			detail: {
				tags: TAGS,
				summary:
					"Object list of the Data tab (tables, key patterns) with their default queries; 409 SERVICE_NOT_RUNNING when stopped, 504 TIMEOUT after 15 s",
			},
		})
		.post(
			"/query",
			({ params, body }) => service.query(params.project, params.name, body),
			{
				params: "Common.ServiceParams",
				body: "Data.QueryBody",
				response: { 200: "Data.Result", ...ERRORS },
				detail: {
					tags: TAGS,
					summary:
						"Run one query in the service container (15 s, 2 MB, 1000 rows max); a rejected query is 422, a timed-out one 504 TIMEOUT",
				},
			},
		);
