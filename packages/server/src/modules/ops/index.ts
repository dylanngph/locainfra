import { Elysia } from "elysia";
import { OP_EVENTS_CONTENT_TYPE, OpsModel, opNotFound } from "./ops.model";
import type { OpEventsService } from "./ops.service";

/**
 * Ops controller (routes only): follow a long-running action over HTTP.
 *
 * @param service - Progress streamer.
 * @returns The `GET /api/ops/:opId/events` route.
 */
export const opsModule = (service: OpEventsService) =>
	new Elysia({ name: "Ops.Controller", prefix: "/api/ops" })
		.model(OpsModel)
		.prefix("model", "Ops.")
		.get(
			"/:opId/events",
			({ params, status }) => {
				const body = service.stream(params.opId);
				if (body === undefined) return status(404, opNotFound(params.opId));
				return new Response(body, {
					headers: {
						"content-type": OP_EVENTS_CONTENT_TYPE,
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
					},
				});
			},
			{
				params: "Ops.Params",
				detail: {
					tags: ["Ops"],
					summary:
						"Progress of one operation as NDJSON (replay, then live, ends after done/error); the fetch alternative to op:<opId> on /ws",
					responses: {
						200: {
							description: "One Progress JSON object per line",
							content: {
								"application/x-ndjson": {
									schema: { type: "string" },
								},
							},
						},
						404: { description: "Unknown or expired operation" },
					},
				},
			},
		);
