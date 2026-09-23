import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KeyRoundIcon, LayoutGridIcon, type LucideIcon } from "lucide-react";
import { Link, Outlet, useLocation, useParams } from "react-router";
import { envQuery } from "@/features/env/api/env.queries";
import { LiveSwitch } from "@/features/live/components/live-switch";
import { RefreshButton } from "@/features/live/components/refresh-button";
import { useProjectLive } from "@/features/live/hooks/use-project-live";
import { projectQuery } from "@/features/projects/api/projects.queries";
import { useProjectStatus } from "@/shared/hooks/use-project-status";
import { cn } from "@/shared/lib/utils";

interface TabProps {
	readonly to: string;
	readonly icon: LucideIcon;
	readonly label: string;
	readonly count: number | undefined;
	readonly active: boolean;
}

function ProjectTab({ to, icon: Icon, label, count, active }: TabProps) {
	return (
		<Link
			to={to}
			aria-current={active ? "page" : undefined}
			className={cn(
				"-mb-px flex h-[42px] items-center gap-2 border-b-2 px-2.5 font-medium text-[13px] hover:text-foreground",
				active
					? "border-foreground text-foreground"
					: "border-transparent text-muted-foreground",
			)}
		>
			<Icon
				aria-hidden
				className={cn("size-[15px]", active ? "opacity-85" : "opacity-50")}
			/>
			{label}
			{count ? (
				<span className="rounded-full bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
					{count}
				</span>
			) : null}
		</Link>
	);
}

/**
 * `/p/:project` shell: the Services / Environment tab bar with Refresh and
 * the Live switch over the project's pages. Data is loaded once; while Live
 * is on, `status:<project>` stays subscribed anywhere in the project.
 */
export function ProjectLayout() {
	const { project = "" } = useParams();
	const { pathname } = useLocation();
	useProjectLive(project);
	const { data } = useSuspenseQuery(projectQuery(project));
	const status = useProjectStatus(project, data.status);
	const { data: env } = useQuery(envQuery(project, "dotenv", false));
	const onEnv = pathname.endsWith("/env");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="sticky top-[52px] z-10 flex items-center gap-0.5 border-b bg-background px-4">
				<ProjectTab
					to={`/p/${project}`}
					icon={LayoutGridIcon}
					label="Services"
					count={status?.services.length}
					active={!onEnv}
				/>
				<ProjectTab
					to={`/p/${project}/env`}
					icon={KeyRoundIcon}
					label="Environment"
					count={env?.lines.length}
					active={onEnv}
				/>
				<div className="ml-auto flex items-center gap-3">
					<RefreshButton project={project} />
					<LiveSwitch project={project} />
				</div>
			</div>
			<main className="min-w-0 flex-1 px-8 pt-7 pb-12">
				<div className="mx-auto flex max-w-[1080px] flex-col gap-[18px]">
					<Outlet />
				</div>
			</main>
		</div>
	);
}
