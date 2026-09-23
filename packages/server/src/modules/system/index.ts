import { Elysia } from "elysia";
import { SystemModel } from "./system.model";
import type { SystemService } from "./system.service";

/**
 * System controller (routes only).
 *
 * @param service - Version reporter.
 * @returns The `GET /api/system` route.
 */
export const systemModule = (service: SystemService) =>
	new Elysia({ name: "System.Controller", prefix: "/api/system" })
		.model(SystemModel)
		.prefix("model", "System.")
		.get("/", () => service.status(), {
			response: { 200: "System.Status" },
			detail: {
				tags: ["System"],
				summary: "Docker and compose versions (header status dot)",
			},
		});
