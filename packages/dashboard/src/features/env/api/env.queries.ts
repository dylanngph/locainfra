import type { EnvPreview } from "@locainfra/server";
import { queryOptions } from "@tanstack/react-query";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { api, unwrap } from "@/shared/lib/api";

/** Env output format (`fmt` search param). */
export type EnvFormat = EnvPreview["format"];

/** Every env format, in segmented-control order. */
export const ENV_FORMATS: readonly EnvFormat[] = ["dotenv", "shell", "json"];

/** `GET …/env?format=&reveal=`: the preview (masked unless revealed). */
export const envQuery = (project: string, format: EnvFormat, reveal: boolean) =>
	queryOptions({
		queryKey: [...PROJECTS_KEY, "detail", project, "env", format, reveal],
		queryFn: () =>
			unwrap(
				api.api.projects({ project }).env.get({ query: { format, reveal } }),
			),
		gcTime: reveal ? 0 : undefined,
	});
