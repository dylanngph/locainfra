import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { ServicesModel } from "./services.model";
import type { ServicesService } from "./services.service";

const TAGS = ["Services"];
const SECRET_TAGS = ["Secrets"];

/** Responses of every long-running service action (progress on `op:<opId>`). */
const ACTION_RESPONSE = {
	202: "Common.OpAccepted",
	404: "Common.Error",
	409: "Common.Error",
	422: "Common.Error",
} as const;

/**
 * Services controller (routes only): the service instances of one project.
 *
 * @param service - Service-instance use-cases.
 * @returns The `/api/projects/:project/services` routes.
 */
export const servicesModule = (service: ServicesService) =>
	new Elysia({
		name: "Services.Controller",
		prefix: "/api/projects/:project/services",
	})
		.model(ServicesModel)
		.prefix("model", "Services.")
		.use(commonModels)
		.get("/", ({ params }) => service.list(params.project), {
			params: "Common.ProjectParams",
			response: {
				200: "Services.List",
				404: "Common.Error",
				422: "Common.Error",
			},
			detail: { tags: TAGS, summary: "Services of a project with status" },
		})
		.post(
			"/",
			async ({ params, body, status }) =>
				status(202, await service.add(params.project, body)),
			{
				params: "Common.ProjectParams",
				body: "Services.Add",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary:
						"Add a service instance to locastack.yaml and start it (Add & start)",
				},
			},
		)
		.get(
			"/:name",
			({ params }) => service.detail(params.project, params.name),
			{
				params: "Common.ServiceParams",
				response: {
					200: "Services.Detail",
					404: "Common.Error",
				},
				detail: { tags: TAGS, summary: "Detail of one service instance" },
			},
		)
		.patch(
			"/:name",
			async ({ params, body, status }) =>
				status(202, await service.update(params.project, params.name, body)),
			{
				params: "Common.ServiceParams",
				body: "Services.Patch",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary:
						"Change version, port (Use port N), persist, config or seed, then recreate",
				},
			},
		)
		.delete(
			"/:name",
			async ({ params, query, status }) =>
				status(
					202,
					await service.remove(
						params.project,
						params.name,
						query.volumes === true,
					),
				),
			{
				params: "Common.ServiceParams",
				query: "Services.RemoveQuery",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary:
						"Remove the container and the entry (optionally its volumes)",
				},
			},
		)
		.post(
			"/:name/start",
			async ({ params, status }) =>
				status(
					202,
					await service.lifecycle(params.project, params.name, "start"),
				),
			{
				params: "Common.ServiceParams",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary: "Start (creating the container if needed)",
				},
			},
		)
		.post(
			"/:name/stop",
			async ({ params, status }) =>
				status(
					202,
					await service.lifecycle(params.project, params.name, "stop"),
				),
			{
				params: "Common.ServiceParams",
				response: ACTION_RESPONSE,
				detail: { tags: TAGS, summary: "Stop" },
			},
		)
		.post(
			"/:name/restart",
			async ({ params, status }) =>
				status(
					202,
					await service.lifecycle(params.project, params.name, "restart"),
				),
			{
				params: "Common.ServiceParams",
				response: ACTION_RESPONSE,
				detail: { tags: TAGS, summary: "Restart" },
			},
		)
		.get(
			"/:name/connection",
			({ params, query }) =>
				service.connection(params.project, params.name, query.reveal === true),
			{
				params: "Common.ServiceParams",
				query: "Services.ConnectionQuery",
				response: {
					200: "Services.Connection",
					404: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary: "Connect tab: primary URL, exports, details and snippets",
				},
			},
		)
		.get(
			"/:name/logs",
			({ params, query }) =>
				service.logTail(params.project, params.name, query.tail),
			{
				params: "Common.ServiceParams",
				query: "Services.LogTailQuery",
				response: {
					200: "Services.LogTail",
					404: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary:
						"Last N log lines, read once (Logs tab without Live; follow with logs:<containerId>)",
				},
			},
		)
		.get(
			"/:name/stats",
			({ params }) => service.statsReading(params.project, params.name),
			{
				params: "Common.ServiceParams",
				response: {
					200: "Services.StatsReading",
					404: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary:
						"One CPU/memory reading, not streamed (Metrics tab without Live; stream with stats:<containerId>)",
				},
			},
		)
		.patch(
			"/:name/secrets/:key/rotate",
			async ({ params, body, status }) =>
				status(
					202,
					await service.rotateSecret(
						params.project,
						params.name,
						params.key,
						body,
					),
				),
			{
				params: "Services.SecretKeyParams",
				body: "Services.RotateSecret",
				response: ACTION_RESPONSE,
				detail: {
					tags: SECRET_TAGS,
					summary:
						"Generate a new secret value and recreate the container (bakedIntoVolume secrets need force + wipeVolume)",
				},
			},
		);
