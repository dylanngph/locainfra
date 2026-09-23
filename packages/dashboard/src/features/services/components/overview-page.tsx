import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { catalogQuery } from "@/features/catalog/api/catalog.queries";
import { projectQuery } from "@/features/projects/api/projects.queries";
import { useProjectActions } from "@/features/projects/hooks/use-project-actions";
import { CliHint } from "@/shared/components/cli-hint";
import { PageHeader } from "@/shared/components/page-header";
import { DashedEmpty } from "@/shared/components/placeholder";
import { useProjectStatus } from "@/shared/hooks/use-project-status";
import { useLiveMode } from "@/shared/lib/live/live-mode";
import { cn } from "@/shared/lib/utils";
import { Button, buttonVariants } from "@/shared/ui/button";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { useServiceActions } from "../hooks/use-service-actions";
import {
	RemoveServiceDialog,
	type RemoveTarget,
} from "./remove-service-dialog";
import { ServiceRow } from "./service-row";

/** `/p/:project`: the project's services with live status and actions. */
export function OverviewPage() {
	const { project = "" } = useParams();
	const { data } = useSuspenseQuery(projectQuery(project));
	const status = useProjectStatus(project, data.status) ?? data.status;
	const { data: catalog } = useQuery(catalogQuery());
	const actions = useServiceActions(project);
	const { startAll, stopAll } = useProjectActions();
	const [busy, setBusy] = useState(false);
	const live = useLiveMode(project);
	const [removing, setRemoving] = useState<RemoveTarget | null>(null);

	const services = status.services;
	const running = services.filter((s) => s.state === "running").length;
	const anyActive = services.some(
		(s) => s.state === "running" || s.state === "starting",
	);
	const definition = (type: string) =>
		catalog?.definitions.find((d) => d.id === type);

	const toggleAll = async () => {
		setBusy(true);
		try {
			await (anyActive ? stopAll(project) : startAll(project));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeader
				title={project}
				subtitle={
					services.length
						? `${running} of ${services.length} running on network ${status.network}`
						: "Empty project"
				}
				actions={
					<>
						{services.length ? (
							<Button
								variant="outline"
								className="h-8 rounded-control px-3"
								disabled={busy}
								onClick={() => void toggleAll()}
							>
								{anyActive ? "Stop all" : "Start all"}
							</Button>
						) : null}
						<Link
							to={`/p/${project}/add`}
							className={cn(buttonVariants(), "h-8 rounded-control px-3")}
						>
							Add service
						</Link>
					</>
				}
			/>
			{services.length ? (
				<div className="overflow-hidden rounded-card border">
					<Table className="table-fixed">
						<TableHeader>
							<TableRow className="bg-subtle hover:bg-subtle">
								<TableHead className="h-auto w-[240px] py-2 pl-4 font-normal text-[12px] text-muted-foreground">
									Service
								</TableHead>
								<TableHead className="h-auto w-[136px] py-2 font-normal text-[12px] text-muted-foreground">
									Status
								</TableHead>
								<TableHead className="h-auto w-[76px] py-2 font-normal text-[12px] text-muted-foreground">
									Port
								</TableHead>
								<TableHead className="h-auto py-2 font-normal text-[12px] text-muted-foreground">
									Resources
								</TableHead>
								<TableHead className="h-auto w-[200px] py-2 pr-4 text-right font-normal text-[12px] text-muted-foreground">
									Actions
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{services.map((service) => (
								<ServiceRow
									key={service.name}
									project={project}
									service={service}
									definition={definition(service.type)}
									actions={actions}
									live={live}
									onRemove={({ name, persist }) =>
										setRemoving({ name, persist })
									}
								/>
							))}
						</TableBody>
					</Table>
				</div>
			) : (
				<DashedEmpty
					title="No services yet"
					description="Add a database, storage bucket or cache. Each one runs as a Docker container on this machine."
					action={
						<Link
							to={`/p/${project}/add`}
							className={cn(buttonVariants(), "h-8 rounded-control px-3")}
						>
							Browse catalog
						</Link>
					}
				/>
			)}
			<RemoveServiceDialog
				project={project}
				target={removing}
				onClose={() => setRemoving(null)}
			/>
			<CliHint
				cwd={data.stack.root}
				command={`locainfra ${anyActive ? "down" : "up"}`}
			/>
		</>
	);
}
