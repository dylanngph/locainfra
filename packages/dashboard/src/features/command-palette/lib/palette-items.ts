import type {
	ProjectSummary,
	ServiceDefinition,
	ServiceStatus,
} from "@locastack/server";

/** Leading visual of a palette item. */
export type PaletteIcon =
	| { readonly kind: "brand"; readonly type: string; readonly icon?: string }
	| { readonly kind: "initial"; readonly name: string }
	| { readonly kind: "env" };

/** A real `locastack` command equivalent to a palette item. */
export interface PaletteCli {
	/** e.g. `locastack up`. */
	readonly command: string;
	/** Project folder it runs in. */
	readonly cwd: string;
}

/** One selectable palette row. */
export interface PaletteItem {
	/** Unique cmdk value. */
	readonly value: string;
	readonly label: string;
	readonly sub: string;
	/** Extra words matched by the filter (type, category, project). */
	readonly keywords: readonly string[];
	readonly icon: PaletteIcon;
	/** Where selecting the item navigates. */
	readonly to: string;
	/** Footer command; absent when the CLI has no equivalent. */
	readonly cli?: PaletteCli;
}

/** A titled group of palette rows. */
export interface PaletteGroup {
	readonly heading: string;
	readonly items: readonly PaletteItem[];
}

/** What the palette is built from. */
export interface PaletteInput {
	/** Project of the current route, if any. */
	readonly project: string | undefined;
	readonly projects: readonly ProjectSummary[];
	readonly definitions: readonly ServiceDefinition[];
	/** Services per project name (projects not loaded yet are skipped). */
	readonly services: Readonly<Record<string, readonly ServiceStatus[]>>;
}

/**
 * Palette groups, as the prototype's `paletteItems()`: "Add to <project>"
 * (catalog → Config page of the current project, else the first project),
 * "Services" (every service of every project → detail), "Projects"
 * (→ overview, `locastack up`) and, inside a project, "Actions" ("Export
 * .env for <project>" → Environment, `locastack env`). Empty groups are
 * left out; cmdk filters by the typed query.
 *
 * @param input - Current project, projects, catalog and loaded services.
 * @returns Groups in display order.
 */
export function buildPaletteGroups(input: PaletteInput): PaletteGroup[] {
	const { projects, definitions, services } = input;
	const current = projects.find((p) => p.name === input.project);
	const target = current ?? projects[0];
	const groups: PaletteGroup[] = [];

	if (target) {
		groups.push({
			heading: `Add to ${target.name}`,
			items: definitions.map((d) => ({
				value: `add:${d.id}`,
				label: d.name,
				sub: d.categoryLabel ?? d.category,
				keywords: [d.id, d.category, d.categoryLabel ?? ""].filter(Boolean),
				icon: { kind: "brand", type: d.id, icon: d.icon },
				to: `/p/${target.name}/add/${d.id}`,
			})),
		});
	}

	const serviceItems = projects.flatMap((p) =>
		(services[p.name] ?? []).map(
			(s): PaletteItem => ({
				value: `service:${p.name}/${s.name}`,
				label: s.name,
				sub: `${p.name}, port ${s.hostPort}`,
				keywords: [s.type, p.name],
				icon: { kind: "brand", type: s.type },
				to: `/p/${p.name}/s/${s.name}`,
			}),
		),
	);
	if (serviceItems.length)
		groups.push({ heading: "Services", items: serviceItems });

	if (projects.length) {
		groups.push({
			heading: "Projects",
			items: projects.map((p) => ({
				value: `project:${p.name}`,
				label: p.name,
				sub: `${p.serviceCount} service${p.serviceCount === 1 ? "" : "s"}`,
				keywords: [],
				icon: { kind: "initial", name: p.name },
				to: `/p/${p.name}`,
				cli: { command: "locastack up", cwd: p.root },
			})),
		});
	}

	if (current) {
		groups.push({
			heading: "Actions",
			items: [
				{
					value: `action:env:${current.name}`,
					label: `Export .env for ${current.name}`,
					sub: "",
					keywords: ["env", ".env", "export", "environment"],
					icon: { kind: "env" },
					to: `/p/${current.name}/env`,
					cli: { command: "locastack env", cwd: current.root },
				},
			],
		});
	}
	return groups;
}
