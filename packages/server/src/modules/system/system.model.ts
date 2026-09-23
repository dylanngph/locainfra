import { SystemInfo } from "@locainfra/core";
import { t } from "elysia";

/** `GET /api/system` response: Docker/compose versions plus the dashboard's own version. */
export const SystemStatus = t.Composite([
	SystemInfo,
	t.Object({
		dashboardVersion: t.String({ description: "LocaInfra version" }),
	}),
]);
/** `GET /api/system` response. */
export type SystemStatus = typeof SystemStatus.static;

/** Reference models of the system controller, registered under `System.`. */
export const SystemModel = { status: SystemStatus };
