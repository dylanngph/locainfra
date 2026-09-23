import { Elysia } from "elysia";
import { commonModels } from "../../models/common.model";
import { SnapshotsModel } from "./snapshots.model";
import type { SnapshotsService } from "./snapshots.service";

const TAGS = ["Snapshots"];

/** Responses of the long-running actions of this controller (progress via `GET /api/ops/:opId/events`). */
const ACTION_RESPONSE = {
	202: "Common.OpAccepted",
	404: "Common.Error",
	409: "Common.Error",
	422: "Common.Error",
} as const;

/**
 * Snapshots and seeding controller (routes only): the data-lifecycle
 * actions of one service instance.
 *
 * @param service - Snapshot and seed use-cases.
 * @returns The `/api/projects/:project/services/:name/{snapshots,seed}` routes.
 */
export const snapshotsModule = (service: SnapshotsService) =>
	new Elysia({
		name: "Snapshots.Controller",
		prefix: "/api/projects/:project/services/:name",
	})
		.model(SnapshotsModel)
		.prefix("model", "Snapshots.")
		.use(commonModels)
		.get(
			"/snapshots",
			({ params }) => service.list(params.project, params.name),
			{
				params: "Common.ServiceParams",
				response: {
					200: "Snapshots.List",
					404: "Common.Error",
				},
				detail: { tags: TAGS, summary: "Snapshots of a service, newest first" },
			},
		)
		.post(
			"/snapshots",
			async ({ params, body, status }) =>
				status(202, await service.create(params.project, params.name, body)),
			{
				params: "Common.ServiceParams",
				body: "Snapshots.Create",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary:
						"Stop the service, tar its volume into a snapshot, start it again",
				},
			},
		)
		.post(
			"/snapshots/:id/restore",
			async ({ params, status }) =>
				status(
					202,
					await service.restore(params.project, params.name, params.id),
				),
			{
				params: "Common.SnapshotParams",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary:
						"Stop the service, replace its volume contents with the snapshot, start it",
				},
			},
		)
		.delete(
			"/snapshots/:id",
			({ params }) => service.remove(params.project, params.name, params.id),
			{
				params: "Common.SnapshotParams",
				response: {
					200: "Snapshots.Snapshot",
					404: "Common.Error",
				},
				detail: {
					tags: TAGS,
					summary: "Delete a snapshot file and its index row",
				},
			},
		)
		.post(
			"/seed",
			async ({ params, status }) =>
				status(202, await service.seed(params.project, params.name)),
			{
				params: "Common.ServiceParams",
				response: ACTION_RESPONSE,
				detail: {
					tags: TAGS,
					summary: "Re-apply the service's seed file in the running container",
				},
			},
		);
