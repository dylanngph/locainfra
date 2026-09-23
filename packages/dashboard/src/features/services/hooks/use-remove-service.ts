import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { invalidationFor } from "@/features/projects/api/project-invalidation";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { trackOp } from "@/shared/lib/track-op";
import { removeService } from "../api/services.api";

/** Removes a service of the project; see {@link useRemoveService}. */
export type RemoveService = (name: string, volumes: boolean) => Promise<void>;

/**
 * Remove action of a project: sends `DELETE …/services/:name?volumes=`,
 * then follows the op in a progress toast (not awaited) and, once it
 * settles, refetches the project's service set and env and drops the
 * removed service's cached queries. Rejects when the request itself fails.
 *
 * @param project - Project name.
 * @returns The remove function.
 */
export function useRemoveService(project: string): RemoveService {
	const queryClient = useQueryClient();
	return useCallback(
		async (name, volumes) => {
			const opId = await removeService(project, name, volumes);
			void trackOp(opId, {
				title: `Removing ${name}…`,
				queryClient,
				invalidate: invalidationFor({ kind: "service-set", project }),
			}).then((event) => {
				if (event.kind === "done")
					queryClient.removeQueries({
						queryKey: [...PROJECTS_KEY, "detail", project, "services", name],
					});
			});
		},
		[project, queryClient],
	);
}
