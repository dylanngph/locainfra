import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { CatalogModel } from "./catalog.model";
import type { CatalogService } from "./catalog.service";

/**
 * Catalog controller (routes only).
 *
 * @param service - Catalog reader.
 * @returns The `GET /api/catalog` and `GET /api/catalog/:type/free-port` routes.
 */
export const catalogModule = (service: CatalogService) =>
	new Elysia({ name: "Catalog.Controller", prefix: "/api/catalog" })
		.model(CatalogModel)
		.prefix("model", "Catalog.")
		.use(commonModels)
		.get("/", () => service.list(), {
			response: {
				200: "Catalog.Listing",
				422: "Common.Error",
			},
			detail: {
				tags: ["Catalog"],
				summary: "Service definitions and filter categories",
			},
		})
		.get("/:type/free-port", ({ params }) => service.freePort(params.type), {
			params: "Catalog.TypeParams",
			response: {
				200: "Catalog.FreePort",
				422: "Common.Error",
			},
			detail: {
				tags: ["Catalog"],
				summary:
					"Host port the Config screen proposes for a new instance of this type",
			},
		});
