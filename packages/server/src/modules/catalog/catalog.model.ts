import { CatalogListing } from "@locainfra/core";
import { t } from "elysia";

/** `GET /api/catalog/:type/free-port` params. */
export const CatalogTypeParams = t.Object({
	type: t.String({ minLength: 1, description: "Catalog id, e.g. postgres" }),
});
/** `GET /api/catalog/:type/free-port` params. */
export type CatalogTypeParams = typeof CatalogTypeParams.static;

/** `GET /api/catalog/:type/free-port` response. */
export const FreePort = t.Object({
	port: t.Union([t.Integer({ minimum: 1, maximum: 65535 }), t.Null()], {
		description:
			"Lowest free host port in the definition's range that no project has pinned (never the canonical default), or null when none was found",
	}),
});
/** `GET /api/catalog/:type/free-port` response. */
export type FreePort = typeof FreePort.static;

/** Reference models of the catalog controller, registered under `Catalog.`. */
export const CatalogModel = {
	listing: CatalogListing,
	typeParams: CatalogTypeParams,
	freePort: FreePort,
};
