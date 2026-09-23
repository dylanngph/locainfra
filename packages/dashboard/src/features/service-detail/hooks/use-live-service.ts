import type { ServiceDetail } from "@locainfra/server";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { projectQuery } from "@/features/projects/api/projects.queries";
import { serviceQuery } from "@/features/services/api/services.queries";
import { useProjectStatus } from "@/shared/hooks/use-project-status";

/**
 * Service detail with the freshest status row (state, uptime, container id,
 * problem, resources) overlaid: the observer snapshot while Live mode is on,
 * otherwise the loaded project status, plus optimistic action states.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @returns The merged detail.
 */
export function useLiveService(project: string, name: string): ServiceDetail {
	const { data } = useSuspenseQuery(serviceQuery(project, name));
	const { data: detail } = useQuery(projectQuery(project));
	const status = useProjectStatus(project, detail?.status);
	const row = status?.services.find((s) => s.name === name);
	if (!row) return data;
	return {
		...data,
		...row,
		problem: row.problem,
		startedAt: row.startedAt,
	};
}
