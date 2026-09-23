import { useQuery } from "@tanstack/react-query";
import {
	CheckIcon,
	ChevronsUpDownIcon,
	LayoutListIcon,
	PlusIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { StatusDot } from "@/shared/components/status";
import { initialOf } from "@/shared/lib/format";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { projectsQuery } from "../api/projects.queries";
import { projectHealth } from "../lib/project-health";

/** Props of {@link ProjectSwitcher}. */
export interface ProjectSwitcherProps {
	/** Current project name. */
	readonly current: string;
	/** Whether this is the last breadcrumb (bolder label). */
	readonly isLast: boolean;
}

/** Breadcrumb project switcher: jump to another project (keeps the Environment page). */
export function ProjectSwitcher({ current, isLast }: ProjectSwitcherProps) {
	const { data: projects = [] } = useQuery(projectsQuery());
	const live = useObserverStore((s) => s.status);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const onEnv = pathname.endsWith("/env");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Switch project (current: ${current})`}
				className="flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-control border border-transparent py-0 pr-1.5 pl-1 hover:bg-muted data-popup-open:border-border data-popup-open:bg-muted"
			>
				<span className="box-border flex size-5 items-center justify-center rounded-[5px] border bg-muted font-semibold text-[11px]">
					{initialOf(current)}
				</span>
				<span className={isLast ? "font-medium" : undefined}>{current}</span>
				<ChevronsUpDownIcon className="size-3.5 opacity-45" aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-[280px] rounded-card p-1.5">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[11px]">
						Switch project
					</DropdownMenuLabel>
					{projects.map((project) => {
						const health = projectHealth(project, live[project.name]);
						const isCurrent = project.name === current;
						return (
							<DropdownMenuItem
								key={project.name}
								onClick={() =>
									navigate(
										onEnv ? `/p/${project.name}/env` : `/p/${project.name}`,
									)
								}
								className={`h-10 gap-2.5 px-2 ${isCurrent ? "bg-subtle" : ""}`}
							>
								<span className="box-border flex size-6 flex-none items-center justify-center rounded-control border bg-background font-semibold text-[11px]">
									{initialOf(project.name)}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block font-medium text-[13px]">
										{project.name}
									</span>
									<span className="block text-[11.5px] text-muted-foreground">
										{health.total
											? `${health.running} of ${health.total} running`
											: "No services"}
									</span>
								</span>
								<StatusDot tone={health.tone} />
								{isCurrent ? (
									<CheckIcon className="size-3.5 opacity-70" />
								) : null}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuGroup>
				<DropdownMenuSeparator className="-mx-1.5 my-1.5" />
				<DropdownMenuItem
					className="h-[34px] gap-2.5 px-2 text-[13px]"
					onClick={() => navigate("/", { state: { newProject: true } })}
				>
					<PlusIcon className="opacity-60" />
					New project
				</DropdownMenuItem>
				<DropdownMenuItem
					className="h-[34px] gap-2.5 px-2 text-[13px]"
					onClick={() => navigate("/")}
				>
					<LayoutListIcon className="opacity-60" />
					All projects
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
