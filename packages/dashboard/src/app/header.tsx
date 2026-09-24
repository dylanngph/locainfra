import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { Link, useMatches, useNavigation, useParams } from "react-router";
import { catalogQuery } from "@/features/catalog/api/catalog.queries";
import { openCommandPalette } from "@/features/command-palette/hooks/use-command-palette";
import { ProjectSwitcher } from "@/features/projects/components/project-switcher";
import { DockerStatus } from "@/features/system/components/docker-status";
import { LogoMark } from "@/shared/brand/logo";
import { cn } from "@/shared/lib/utils";
import { Kbd } from "@/shared/ui/kbd";
import { crumbOf } from "./route-handle";

interface Crumb {
	readonly label: string;
	readonly to?: string;
}

const Separator = () => (
	<span className="text-[#d4d4d4]" aria-hidden>
		/
	</span>
);

function useCrumbs(): Crumb[] {
	const matches = useMatches();
	const { project, type, service } = useParams();
	const kind = [...matches]
		.reverse()
		.map((m) => crumbOf(m.handle))
		.find(Boolean);
	const { data: catalog } = useQuery({
		...catalogQuery(),
		enabled: kind === "config",
	});
	if (!project || !kind) return [];
	const add: Crumb = { label: "Add service", to: `/p/${project}/add` };
	switch (kind) {
		case "catalog":
			return [add];
		case "config":
			return [
				add,
				{
					label:
						catalog?.definitions.find((d) => d.id === type)?.name ?? type ?? "",
				},
			];
		case "service":
			return [{ label: service ?? "" }];
		case "env":
			return [{ label: "Environment" }];
	}
}

/** Sticky 52px app header: logo, breadcrumb with project switcher, ⌘K search, Docker status. */
export function AppHeader() {
	const { project } = useParams();
	const crumbs = useCrumbs();
	const navigation = useNavigation();

	return (
		<header className="sticky top-0 z-20 flex h-[52px] flex-none items-center gap-3.5 border-b bg-background px-4">
			<Link
				to="/"
				className="flex items-center gap-[9px] font-semibold text-[14px] tracking-[-0.01em]"
			>
				<LogoMark size={18} />
				LocaStack
			</Link>
			<nav
				aria-label="Breadcrumb"
				className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]"
			>
				<Separator />
				<Link
					to="/"
					className={cn(
						"whitespace-nowrap rounded-[4px] px-1 py-0.5 hover:bg-muted",
						project ? "text-muted-foreground" : "font-medium text-foreground",
					)}
				>
					Projects
				</Link>
				{project ? (
					<>
						<Separator />
						<ProjectSwitcher current={project} isLast={crumbs.length === 0} />
					</>
				) : null}
				{crumbs.map((crumb, i) => {
					const last = i === crumbs.length - 1;
					const className = cn(
						"whitespace-nowrap rounded-[4px] px-1 py-0.5",
						last
							? "font-medium text-foreground"
							: "text-muted-foreground hover:bg-muted",
					);
					return (
						<Fragment key={crumb.to ?? crumb.label}>
							<Separator />
							{crumb.to && !last ? (
								<Link to={crumb.to} className={className}>
									{crumb.label}
								</Link>
							) : (
								<span
									aria-current={last ? "page" : undefined}
									className={className}
								>
									{crumb.label}
								</span>
							)}
						</Fragment>
					);
				})}
			</nav>
			<button
				type="button"
				onClick={openCommandPalette}
				aria-keyshortcuts="Meta+K Control+K"
				className="flex h-8 min-w-[220px] items-center gap-2.5 rounded-control border bg-subtle py-0 pr-1.5 pl-3 text-[13px] text-muted-foreground hover:bg-muted max-md:hidden"
			>
				<span className="flex-1 text-left">Search or add a service…</span>
				<Kbd className="font-mono">⌘K</Kbd>
			</button>
			<DockerStatus />
			{navigation.state === "loading" ? (
				<div
					aria-hidden
					className="absolute inset-x-0 bottom-[-1px] h-0.5 overflow-hidden bg-transparent"
				>
					<div className="h-full w-1/3 animate-[ls-indeterminate_1s_ease-in-out_infinite] bg-foreground/60" />
				</div>
			) : null}
		</header>
	);
}
