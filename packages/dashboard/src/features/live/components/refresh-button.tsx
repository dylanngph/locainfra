import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { projectRefreshFilters } from "@/features/projects/api/project-invalidation";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { SYSTEM_KEY } from "@/features/system/api/system.queries";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";

/** Props of {@link RefreshButton}. */
export interface RefreshButtonProps {
	/** Project whose queries to refetch; omitted → the project list only. */
	readonly project?: string;
}

/**
 * Small "Refresh" button: refetches the project's queries (status, services,
 * connections, env), the project list and Docker status once. The
 * dashboard never polls, so this is how to pick up changes made elsewhere
 * (e.g. the CLI) while Live mode is off.
 */
export function RefreshButton({ project }: RefreshButtonProps) {
	const queryClient = useQueryClient();
	const fetching = useIsFetching({
		queryKey: project ? [...PROJECTS_KEY, "detail", project] : PROJECTS_KEY,
	});
	const refresh = () => {
		const filters = project
			? projectRefreshFilters(project)
			: [{ queryKey: [...PROJECTS_KEY, "list"] }];
		for (const f of [...filters, { queryKey: SYSTEM_KEY }])
			void queryClient.invalidateQueries(f);
	};
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 gap-1.5 rounded-control px-2 text-[12.5px] text-muted-foreground"
			onClick={refresh}
			disabled={fetching > 0}
		>
			<RefreshCwIcon
				aria-hidden
				className={cn("size-3.5", fetching > 0 && "animate-spin")}
			/>
			Refresh
		</Button>
	);
}
