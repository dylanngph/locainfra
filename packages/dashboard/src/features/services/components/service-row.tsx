import type { ServiceDefinition, ServiceStatus } from "@locastack/server";
import {
	CpuIcon,
	EllipsisIcon,
	MemoryStickIcon,
	PlayIcon,
	RotateCwIcon,
	SquareIcon,
	Trash2Icon,
} from "lucide-react";
import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import { BrandChip } from "@/shared/components/brand-chip";
import { MetaChip } from "@/shared/components/meta-chip";
import { StatusBadge } from "@/shared/components/status";
import { useChannel } from "@/shared/hooks/use-channel";
import {
	formatCpu,
	formatMem,
	formatReading,
	NO_READING_HINT,
} from "@/shared/lib/format";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import { Button } from "@/shared/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { TableCell, TableRow } from "@/shared/ui/table";
import type { ServiceActions } from "../hooks/use-service-actions";

/** Props of {@link ServiceRow}. */
export interface ServiceRowProps {
	readonly project: string;
	readonly service: ServiceStatus;
	readonly definition: ServiceDefinition | undefined;
	readonly actions: ServiceActions;
	/** Live mode: stream this row's CPU/MEM (`stats:<containerId>`). */
	readonly live: boolean;
	/** Opens the Remove dialog for this service. */
	readonly onRemove: (service: ServiceStatus) => void;
}

const stop = (fn: () => void) => (event: MouseEvent) => {
	event.stopPropagation();
	fn();
};

/** Swallows clicks so they do not reach the row (menus portal but bubble in React). */
const isolate = (event: MouseEvent) => event.stopPropagation();

/**
 * Latest CPU/MEM of a row: the newest streamed sample while Live mode
 * subscribes `stats:<containerId>`, else the status row's values, which the
 * server only sends while it has a fresh sample (`undefined` → `—`).
 */
function useRowResources(service: ServiceStatus, live: boolean) {
	const id = service.containerId;
	useChannel(live && id && service.state === "running" ? `stats:${id}` : null);
	const latest = useObserverStore((s) =>
		live && id ? s.stats[id]?.at(-1) : undefined,
	);
	return {
		cpuPercent: latest?.cpuPercent ?? service.cpuPercent,
		memBytes: latest?.memBytes ?? service.memBytes,
	};
}

/** One service in the overview table, with every row state and its actions. */
export function ServiceRow({
	project,
	service,
	definition,
	actions,
	live,
	onRemove,
}: ServiceRowProps) {
	const navigate = useNavigate();
	const resources = useRowResources(service, live);
	const href = `/p/${project}/s/${service.name}`;
	const running = service.state === "running";
	const active = running || service.state === "starting";
	const conflict = service.state === "port-conflict";
	const suggested = service.problem?.suggestedPort;

	return (
		<TableRow
			data-state={service.state}
			onClick={() => navigate(href)}
			className="cursor-pointer hover:bg-subtle"
		>
			<TableCell className="w-[200px] py-[11px] pl-4">
				<div className="flex min-w-0 items-center gap-2.5">
					<BrandChip type={service.type} icon={definition?.icon} />
					<span className="min-w-0">
						<Link
							to={href}
							onClick={(e) => e.stopPropagation()}
							className="block truncate font-medium text-[13px]"
						>
							{service.name}
						</Link>
						<span className="block truncate text-[12px] text-muted-foreground">
							{definition?.name ?? service.type} {service.version}
						</span>
					</span>
				</div>
			</TableCell>
			<TableCell className="w-[124px]">
				<StatusBadge state={service.state} />
			</TableCell>
			<TableCell className="w-16 font-mono text-[#404040] text-[12px]">
				:{service.hostPort}
			</TableCell>
			<TableCell>
				<div className="flex min-w-0 items-center gap-1.5">
					{running ? (
						<>
							<MetaChip
								icon={CpuIcon}
								title={
									resources.cpuPercent === undefined
										? NO_READING_HINT
										: undefined
								}
							>
								{formatReading(resources.cpuPercent, formatCpu)}
							</MetaChip>
							<MetaChip
								icon={MemoryStickIcon}
								title={
									resources.memBytes === undefined ? NO_READING_HINT : undefined
								}
							>
								{formatReading(resources.memBytes, formatMem)}
							</MetaChip>
						</>
					) : conflict ? (
						<span className="text-[12px] text-status-error-fg">
							Port {service.hostPort} is already in use
						</span>
					) : service.state === "error" ? (
						<span className="truncate text-[12px] text-status-error-fg">
							{service.problem?.message ?? "The container exited with an error"}
						</span>
					) : (
						<span className="text-[#a3a3a3] text-[12px]">—</span>
					)}
				</div>
			</TableCell>
			<TableCell className="pr-4 text-right">
				<div className="flex justify-end gap-1.5">
					{conflict && suggested ? (
						<Button
							size="sm"
							className="h-7 rounded-control text-[12px]"
							onClick={stop(
								() => void actions.movePort(service.name, suggested),
							)}
						>
							Use port {suggested}
						</Button>
					) : (
						<>
							<Button
								variant="outline"
								size="sm"
								className="h-7 rounded-control text-[12px]"
								onClick={stop(() => void actions.copyUrl(service.name))}
							>
								Copy URL
							</Button>
							<Button
								variant="outline"
								size="icon-sm"
								className="size-7 rounded-control"
								title="Restart"
								aria-label={`Restart ${service.name}`}
								onClick={stop(() => void actions.restart(service.name))}
							>
								<RotateCwIcon className="size-3.5" />
							</Button>
							<Button
								variant="outline"
								size="icon-sm"
								className="size-7 rounded-control"
								title={active ? "Stop" : "Start"}
								aria-label={`${active ? "Stop" : "Start"} ${service.name}`}
								onClick={stop(
									() =>
										void (active
											? actions.stop(service.name)
											: actions.start(service.name)),
								)}
							>
								{active ? (
									<SquareIcon className="size-3 fill-current" />
								) : (
									<PlayIcon className="size-3 fill-current" />
								)}
							</Button>
						</>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="outline"
									size="icon-sm"
									className="size-7 rounded-control"
									aria-label={`More actions for ${service.name}`}
									title="More"
									onClick={isolate}
								/>
							}
						>
							<EllipsisIcon className="size-3.5" />
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="w-44 rounded-card p-1"
							onClick={isolate}
						>
							<DropdownMenuItem
								variant="destructive"
								className="gap-2 text-[13px]"
								onClick={() => onRemove(service)}
							>
								<Trash2Icon className="size-3.5" />
								Remove service…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</TableCell>
		</TableRow>
	);
}
