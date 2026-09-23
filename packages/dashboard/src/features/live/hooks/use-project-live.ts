import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { projectQuery } from "@/features/projects/api/projects.queries";
import { useLiveMode } from "@/shared/lib/live/live-mode";
import { subscribeChannel } from "@/shared/lib/observer/observer";
import { useObserverStore } from "@/shared/lib/observer/observer-store";

/**
 * Keeps `status:<project>` subscribed while Live mode is on for the project
 * (the project layout calls this once). Turning Live off or leaving the
 * project releases the channel, so the socket closes when nothing else uses
 * it; the last snapshot is written into the project query first, so the
 * page keeps showing the freshest status without refetching.
 *
 * @param project - Project name.
 * @returns Whether Live mode is on.
 */
export function useProjectLive(project: string): boolean {
	const live = useLiveMode(project);
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!live || !project) return;
		const release = subscribeChannel(`status:${project}`);
		return () => {
			const snapshot = useObserverStore.getState().status[project];
			if (snapshot) {
				queryClient.setQueryData(projectQuery(project).queryKey, (old) =>
					old ? { ...old, status: snapshot } : old,
				);
			}
			release();
		};
	}, [live, project, queryClient]);
	return live;
}
