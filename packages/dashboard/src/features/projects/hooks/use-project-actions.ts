import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/shared/lib/api-error";
import { trackOp } from "@/shared/lib/track-op";
import { invalidationFor } from "../api/project-invalidation";
import { projectDown, projectUp } from "../api/projects.api";

/**
 * Start all / Stop all for a project: calls `up`/`down` and follows the op.
 *
 * @returns `startAll` and `stopAll`, resolving when the op settles.
 */
export function useProjectActions() {
	const queryClient = useQueryClient();
	const run = useCallback(
		async (project: string, action: "up" | "down") => {
			try {
				const opId =
					action === "up"
						? await projectUp(project)
						: await projectDown(project);
				await trackOp(opId, {
					title:
						action === "up" ? `Starting ${project}…` : `Stopping ${project}…`,
					queryClient,
					invalidate: invalidationFor({ kind: "project-state", project }),
				});
			} catch (error) {
				toast.error(errorMessage(error));
			}
		},
		[queryClient],
	);
	return {
		startAll: (project: string) => run(project, "up"),
		stopAll: (project: string) => run(project, "down"),
	};
}
