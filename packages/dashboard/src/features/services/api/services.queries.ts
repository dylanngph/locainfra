import { queryOptions } from "@tanstack/react-query";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { api, unwrap } from "@/shared/lib/api";

/** `GET …/services/:name`: detail of one instance. */
export const serviceQuery = (project: string, name: string) =>
	queryOptions({
		queryKey: [...PROJECTS_KEY, "detail", project, "services", name],
		queryFn: () =>
			unwrap(api.api.projects({ project }).services({ name }).get()),
	});

/** `GET …/services/:name/connection?reveal=`: Connect tab data. */
export const connectionQuery = (
	project: string,
	name: string,
	reveal: boolean,
) =>
	queryOptions({
		queryKey: [
			...PROJECTS_KEY,
			"detail",
			project,
			"services",
			name,
			"connection",
			reveal,
		],
		queryFn: () =>
			unwrap(
				api.api
					.projects({ project })
					.services({ name })
					.connection.get({ query: { reveal } }),
			),
		staleTime: reveal ? 0 : 5_000,
		gcTime: reveal ? 0 : undefined,
	});
