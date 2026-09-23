import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { ImportDialog } from "@/features/import/components/import-dialog";
import { RefreshButton } from "@/features/live/components/refresh-button";
import { PageHeader } from "@/shared/components/page-header";
import { pluralize } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { projectsQuery } from "../api/projects.queries";
import { NewProjectCard } from "./new-project-card";
import { ProjectCard } from "./project-card";

/** `/`: every registered project as a card, plus the inline New project card. */
export function ProjectsPage() {
	const { data: projects } = useSuspenseQuery(projectsQuery());
	const location = useLocation();
	const requested =
		typeof location.state === "object" &&
		location.state !== null &&
		"newProject" in location.state;
	const [creating, setCreating] = useState(requested);
	const [importing, setImporting] = useState(false);
	useEffect(() => {
		if (requested) setCreating(true);
	}, [requested]);
	const running = projects.reduce((total, p) => total + p.running, 0);

	return (
		<main className="flex flex-1 justify-center px-8 py-9">
			<div className="flex w-full max-w-[1040px] flex-col gap-[22px]">
				<PageHeader
					title="Projects"
					subtitle={`${pluralize(projects.length, "project")}, ${pluralize(running, "container")} running`}
					actions={
						<>
							<RefreshButton />
							<Button
								variant="outline"
								className="h-8 rounded-control px-3"
								onClick={() => setImporting(true)}
							>
								Import docker-compose.yml
							</Button>
							<Button
								className="h-8 rounded-control px-3"
								onClick={() => setCreating(true)}
							>
								New project
							</Button>
						</>
					}
				/>
				<div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">
					{projects.map((project) => (
						<ProjectCard key={project.name} project={project} />
					))}
					{creating ? (
						<NewProjectCard
							takenNames={projects.map((p) => p.name)}
							roots={projects.map((p) => p.root)}
							onCancel={() => setCreating(false)}
						/>
					) : (
						<button
							type="button"
							onClick={() => setCreating(true)}
							className="flex min-h-[170px] flex-col items-center justify-center gap-1.5 rounded-card border border-[#d4d4d4] border-dashed bg-background text-muted-foreground hover:border-[#a3a3a3] hover:text-foreground"
						>
							<span className="text-[20px] leading-none" aria-hidden>
								+
							</span>
							<span className="font-medium text-[13px]">New project</span>
						</button>
					)}
				</div>
			</div>
			<ImportDialog
				open={importing}
				onOpenChange={setImporting}
				takenNames={projects.map((p) => p.name)}
				roots={projects.map((p) => p.root)}
			/>
		</main>
	);
}
