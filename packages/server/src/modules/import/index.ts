import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { ImportModel } from "./import.model";
import type { ImportService } from "./import.service";

const TAGS = ["Import"];

/**
 * Import controller (routes only): turn a docker-compose.yml into a new
 * project.
 *
 * @param service - Import use-cases.
 * @returns The `/api/import` routes.
 */
export const importModule = (service: ImportService) =>
	new Elysia({ name: "Import.Controller", prefix: "/api/import" })
		.model(ImportModel)
		.prefix("model", "Import.")
		.use(commonModels)
		.post("/preview", ({ body }) => service.preview(body), {
			body: "Import.PreviewBody",
			response: {
				200: "Import.Preview",
				422: "Common.Error",
			},
			detail: {
				tags: TAGS,
				summary:
					"Parse compose YAML and map its services onto the catalog (nothing is written)",
			},
		})
		.post(
			"/",
			async ({ body, status }) => status(202, await service.import(body)),
			{
				body: "Import.Body",
				response: {
					202: "Common.OpAccepted",
					404: "Common.Error",
					409: "Common.Error",
					422: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary:
						"Create the project folder and locastack.yaml from the reviewed preview, store secrets, register, optionally start",
				},
			},
		);
