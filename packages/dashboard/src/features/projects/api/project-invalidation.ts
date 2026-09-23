import type { InvalidateQueryFilters } from "@tanstack/react-query";
import { PROJECTS_KEY } from "./projects.queries";

/** What an op changed, so only the matching queries are refetched. */
export type OpScope =
	/** start/stop/restart of one service: its state only. */
	| {
			readonly kind: "service-state";
			readonly project: string;
			readonly service: string;
	  }
	/** PATCH of one service (port, version, config): state, connection, env. */
	| {
			readonly kind: "service-config";
			readonly project: string;
			readonly service: string;
	  }
	/** add/remove of a service: the project's service set and env. */
	| { readonly kind: "service-set"; readonly project: string }
	/** up/down of a whole project: every service's state. */
	| { readonly kind: "project-state"; readonly project: string };

const list = { queryKey: [...PROJECTS_KEY, "list"], exact: true } as const;
const detailKey = (project: string) =>
	[...PROJECTS_KEY, "detail", project] as const;

/**
 * Query filters to invalidate once an op settles: the project detail
 * (status), the project list (card counts) and only the sub-queries the op
 * can have changed. Invalidation refetches active queries and marks the
 * rest stale, so nothing polls.
 *
 * @param scope - What the op touched.
 * @returns Filters for `queryClient.invalidateQueries`.
 */
export function invalidationFor(scope: OpScope): InvalidateQueryFilters[] {
	const project = { queryKey: detailKey(scope.project), exact: true };
	const services = [...detailKey(scope.project), "services"] as const;
	const env = { queryKey: [...detailKey(scope.project), "env"] };
	switch (scope.kind) {
		case "service-state":
			return [
				project,
				{ queryKey: [...services, scope.service], exact: true },
				list,
			];
		case "service-config":
			return [project, { queryKey: [...services, scope.service] }, env, list];
		case "service-set":
			return [project, env, list];
		case "project-state":
			return [project, { queryKey: services }, list];
	}
}

/**
 * Every query of one project (Refresh button): detail, services,
 * connections and env previews, plus the project list.
 *
 * @param project - Project name.
 * @returns Filters for `queryClient.invalidateQueries`.
 */
export function projectRefreshFilters(
	project: string,
): InvalidateQueryFilters[] {
	return [{ queryKey: detailKey(project) }, list];
}
