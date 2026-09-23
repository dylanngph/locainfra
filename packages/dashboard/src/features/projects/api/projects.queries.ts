import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/lib/api";

/** Root key of everything project-scoped; invalidated when an op settles. */
export const PROJECTS_KEY = ["projects"] as const;

/** `GET /api/projects`: project cards and the header switcher. */
export const projectsQuery = () =>
	queryOptions({
		queryKey: [...PROJECTS_KEY, "list"],
		queryFn: () => unwrap(api.api.projects.get()),
	});

/** `GET /api/projects/:project`: stack file plus status. */
export const projectQuery = (project: string) =>
	queryOptions({
		queryKey: [...PROJECTS_KEY, "detail", project],
		queryFn: () => unwrap(api.api.projects({ project }).get()),
	});
