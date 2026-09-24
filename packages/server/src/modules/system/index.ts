import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { SystemModel } from "./system.model";
import type { SystemService } from "./system.service";

const TAGS = ["System"];

/**
 * System controller (routes only).
 *
 * @param service - Versions, setup planner and Docker starter.
 * @returns The `/api/system` routes.
 */
export const systemModule = (service: SystemService) =>
	new Elysia({ name: "System.Controller", prefix: "/api/system" })
		.model(SystemModel)
		.prefix("model", "System.")
		.use(commonModels)
		.get("/", () => service.status(), {
			response: { 200: "System.Status" },
			detail: {
				tags: TAGS,
				summary: "Docker and compose versions (header status dot)",
			},
		})
		.get("/setup", () => service.setup(), {
			response: { 200: "System.Setup" },
			detail: {
				tags: TAGS,
				summary:
					"Doctor report and the setup plan for this machine (never executes anything)",
			},
		})
		.post(
			"/docker/start",
			async ({ body, status }) => status(202, await service.startDocker(body)),
			{
				body: "System.StartDocker",
				response: {
					202: "Common.OpAccepted",
					409: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary:
						"Start the installed Docker runtime (colima start, open -a Docker/OrbStack); progress on op:<opId>. 409 DOCKER_NOT_INSTALLED / SETUP_UNSUPPORTED / SETUP_NEEDS_TERMINAL when the dashboard cannot start it (details.fix: run `locastack setup`)",
				},
			},
		);
