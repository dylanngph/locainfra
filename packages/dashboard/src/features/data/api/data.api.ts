import { queryOptions } from "@tanstack/react-query";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { api, unwrap } from "@/shared/lib/api";

const dataRoutes = (project: string, name: string) =>
	api.api.projects({ project }).services({ name }).data;

/**
 * `GET …/services/:name/data`: the Data tab's object list.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns Kind, list label, objects with their default queries.
 * @throws ApiRequestError (`409 SERVICE_NOT_RUNNING`, `422`, …).
 */
export const fetchDataObjects = (project: string, name: string) =>
	unwrap(dataRoutes(project, name).get());

/**
 * `POST …/services/:name/data/query`: runs one query in the container.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param query - Query text (SQL or a redis command line).
 * @returns Columns, rows (cells as text), row count, truncation and duration.
 * @throws ApiRequestError (`422` with the engine's error line, `409` when stopped).
 */
export const runDataQuery = (project: string, name: string, query: string) =>
	unwrap(dataRoutes(project, name).query.post({ query }));

/**
 * The Data tab's object list (`Data.Objects`), one object (`{ name,
 * defaultQuery }`) and a query result grid (`Data.Result`).
 */
export type {
	DataObject,
	DataObjects,
	DataQueryResult,
} from "@locainfra/server";

/**
 * Query of the object list. Under the service's key, so Refresh refetches it;
 * it only runs while the service runs (the route is `409` otherwise).
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns Query options.
 */
export const dataObjectsQuery = (project: string, name: string) =>
	queryOptions({
		queryKey: [
			...PROJECTS_KEY,
			"detail",
			project,
			"services",
			name,
			"data",
		] as const,
		queryFn: () => fetchDataObjects(project, name),
	});
