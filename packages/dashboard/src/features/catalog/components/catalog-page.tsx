import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { openCommandPalette } from "@/features/command-palette/hooks/use-command-palette";
import { BrandChip } from "@/shared/components/brand-chip";
import { PageHeader } from "@/shared/components/page-header";
import { DashedEmpty } from "@/shared/components/placeholder";
import { Segmented } from "@/shared/components/segmented";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { catalogQuery } from "../api/catalog.queries";
import { useCatalogFilters } from "../hooks/use-catalog-filters";
import {
	ALL_CATEGORIES,
	categoryLabel,
	filterCatalog,
	imageOf,
} from "../lib/filter-catalog";

/** `/p/:project/add`: searchable, filterable catalog of services to add. */
export function CatalogPage() {
	const { project = "" } = useParams();
	const { data } = useSuspenseQuery(catalogQuery());
	const [{ q, cat }, setFilters] = useCatalogFilters();
	const known =
		cat === ALL_CATEGORIES || data.categories.some((c) => c.id === cat);
	const items = filterCatalog(
		data.definitions,
		q,
		known ? cat : ALL_CATEGORIES,
	);
	const options = [
		{ value: ALL_CATEGORIES, label: "All" },
		...data.categories.map((c) => ({ value: c.id, label: c.label })),
	];

	return (
		<>
			<PageHeader
				title="Add a service"
				subtitle={`Each service runs as a Docker container in ${project}.`}
				actions={
					<Button
						variant="outline"
						className="h-8 gap-2 rounded-control px-3"
						onClick={openCommandPalette}
						aria-keyshortcuts="Meta+K Control+K"
					>
						Quick add
						<span className="font-mono text-[11px] text-muted-foreground">
							⌘K
						</span>
					</Button>
				}
			/>
			<Input
				type="search"
				aria-label="Search services"
				value={q}
				onChange={(e) => void setFilters({ q: e.target.value || null })}
				placeholder="Search postgres, s3, redis…"
				className="h-[38px] rounded-lg px-3 text-[14px]"
			/>
			<Segmented
				label="Category"
				value={known ? cat : ALL_CATEGORIES}
				options={options}
				onChange={(value) =>
					void setFilters({ cat: value === ALL_CATEGORIES ? null : value })
				}
				className="self-start"
			/>
			{items.length ? (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
					{items.map((d) => (
						<Link
							key={d.id}
							to={`/p/${project}/add/${d.id}`}
							className="flex flex-col gap-2 rounded-card border bg-card p-3.5 text-left hover:border-[#a3a3a3] hover:shadow-[0_1px_2px_rgba(0,0,0,.05)]"
						>
							<div className="flex w-full items-center gap-2.5">
								<BrandChip type={d.id} icon={d.icon} size="md" />
								<span className="flex-1" />
								<span className="rounded-full border px-2 text-[11px] text-muted-foreground">
									{categoryLabel(d, data.categories)}
								</span>
							</div>
							<div>
								<div className="font-semibold text-[14px]">{d.name}</div>
								<div className="font-mono text-[11px] text-muted-foreground">
									{imageOf(d)}
								</div>
							</div>
							{d.description ? (
								<div className="text-[#525252] text-[12px]">
									{d.description}
								</div>
							) : null}
						</Link>
					))}
				</div>
			) : (
				<DashedEmpty
					title="No services match"
					description={
						q
							? `Nothing in the catalog matches “${q}”.`
							: "This category is empty."
					}
				/>
			)}
		</>
	);
}
