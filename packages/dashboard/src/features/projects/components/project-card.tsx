import type { ProjectSummary } from "@locainfra/server";
import { CpuIcon, MemoryStickIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { TypeChip } from "@/shared/components/brand-chip";
import { MetaChip } from "@/shared/components/meta-chip";
import { StatusPill } from "@/shared/components/status";
import {
	formatCpu,
	formatMem,
	formatReading,
	initialOf,
	NO_READING_HINT,
	pluralize,
} from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { useProjectActions } from "../hooks/use-project-actions";
import { projectHealth } from "../lib/project-health";

const MAX_CHIPS = 4;

/** Props of {@link ProjectCard}. */
export interface ProjectCardProps {
	readonly project: ProjectSummary;
}

/**
 * A project on the Projects grid: status, type chips, resources, Start/Stop
 * all. Loaded once from `GET /api/projects` (Live mode applies only inside a
 * project); refetched after Start/Stop all or on Refresh.
 */
export function ProjectCard({ project }: ProjectCardProps) {
	const health = projectHealth(project);
	const { startAll, stopAll } = useProjectActions();
	const [busy, setBusy] = useState(false);
	const types = project.types;
	const anyRunning = health.running > 0;

	const toggle = async () => {
		setBusy(true);
		try {
			await (anyRunning ? stopAll(project.name) : startAll(project.name));
		} finally {
			setBusy(false);
		}
	};

	return (
		<article
			aria-label={project.name}
			className="relative flex flex-col gap-3 rounded-card border bg-card p-4 transition-[border-color,box-shadow] hover:border-[#a3a3a3] hover:shadow-[0_1px_2px_rgba(0,0,0,.05)]"
		>
			<Link
				to={`/p/${project.name}`}
				aria-label={`Open ${project.name}`}
				className="absolute inset-0 rounded-card focus-visible:outline-2 focus-visible:outline-ring"
			/>
			<div className="flex items-center gap-2.5">
				<div className="flex size-8 items-center justify-center rounded-[7px] border bg-muted font-semibold text-[13px]">
					{initialOf(project.name)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate font-semibold text-[14px]">
						{project.name}
					</div>
					<div className="text-[12px] text-muted-foreground">
						{health.total ? pluralize(health.total, "service") : "No services"}
					</div>
				</div>
				<StatusPill tone={health.tone} label={health.label} />
			</div>
			<div className="flex min-h-[22px] flex-wrap gap-1.5">
				{types.slice(0, MAX_CHIPS).map((type, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: several instances may share a type
					<TypeChip key={`${type}-${i}`} type={type} />
				))}
				{types.length > MAX_CHIPS ? (
					<span className="inline-flex items-center rounded-[5px] border bg-subtle px-[7px] font-medium font-mono text-[11px] text-muted-foreground leading-5">
						+{types.length - MAX_CHIPS}
					</span>
				) : null}
			</div>
			<div className="flex min-h-[22px] items-center gap-1.5">
				{project.issue ? (
					<span className="truncate text-[12px] text-status-error-fg">
						{project.issue}
					</span>
				) : anyRunning ? (
					<>
						<MetaChip
							icon={CpuIcon}
							title={
								health.cpuPercent === undefined ? NO_READING_HINT : undefined
							}
						>
							{formatReading(health.cpuPercent, formatCpu)}
						</MetaChip>
						<MetaChip
							icon={MemoryStickIcon}
							title={
								health.memBytes === undefined ? NO_READING_HINT : undefined
							}
						>
							{formatReading(health.memBytes, formatMem)}
						</MetaChip>
					</>
				) : (
					<span className="text-[#a3a3a3] text-[12px]">Not running</span>
				)}
			</div>
			<div className="flex items-center gap-2 border-hairline border-t pt-3">
				<Button
					variant="outline"
					size="sm"
					className="relative z-10 h-7 rounded-control text-[12px]"
					disabled={busy || health.total === 0 || Boolean(project.issue)}
					onClick={() => void toggle()}
				>
					{anyRunning ? "Stop all" : "Start all"}
				</Button>
				<div className="flex-1" />
				<span className="text-[12px] text-muted-foreground">Open →</span>
			</div>
		</article>
	);
}
