import { useQueries, useQuery } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { catalogQuery } from "@/features/catalog/api/catalog.queries";
import {
	projectQuery,
	projectsQuery,
} from "@/features/projects/api/projects.queries";
import { BrandChip } from "@/shared/components/brand-chip";
import { initialOf } from "@/shared/lib/format";
import { shortPath } from "@/shared/lib/shell";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/shared/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/shared/ui/dialog";
import {
	useCommandPaletteStore,
	usePaletteShortcut,
} from "../hooks/use-command-palette";
import {
	buildPaletteGroups,
	type PaletteIcon,
	type PaletteItem,
} from "../lib/palette-items";

function ItemIcon({ icon }: { readonly icon: PaletteIcon }) {
	if (icon.kind === "brand")
		return <BrandChip type={icon.type} icon={icon.icon} />;
	return (
		<span className="flex size-7 flex-none items-center justify-center rounded-control border bg-background font-semibold text-[11px]">
			{icon.kind === "initial" ? (
				initialOf(icon.name)
			) : (
				<KeyRoundIcon className="size-3.5 opacity-70" />
			)}
		</span>
	);
}

/**
 * Loads what the palette lists, only while it is open: projects and catalog
 * are usually cached already; each project's services come from
 * `GET /api/projects/:project` (cached by the project pages).
 */
function usePaletteGroups(open: boolean) {
	const { project } = useParams();
	const { data: projects = [] } = useQuery({
		...projectsQuery(),
		enabled: open,
	});
	const { data: catalog } = useQuery({ ...catalogQuery(), enabled: open });
	const details = useQueries({
		queries: projects.map((p) => ({
			...projectQuery(p.name),
			enabled: open && !p.issue,
		})),
	});
	const services = Object.fromEntries(
		details.flatMap((q) =>
			q.data ? [[q.data.stack.name, q.data.status.services] as const] : [],
		),
	);
	const key = details.map((q) => q.dataUpdatedAt).join();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` tracks the per-project results
	return useMemo(
		() =>
			buildPaletteGroups({
				project,
				projects,
				definitions: catalog?.definitions ?? [],
				services,
			}),
		[project, projects, catalog, key],
	);
}

/**
 * ⌘K command palette (shadcn Command in a Dialog): "Add to <project>",
 * "Services", "Projects" and "Actions", keyboard-navigable through cmdk.
 * The footer shows the real CLI equivalent of the highlighted row when one
 * exists (`locastack up` / `locastack env`), otherwise nothing. The
 * highlight resets to the first row every time the palette opens.
 */
export function CommandPalette() {
	usePaletteShortcut();
	const open = useCommandPaletteStore((s) => s.open);
	const setOpen = useCommandPaletteStore((s) => s.setOpen);
	const navigate = useNavigate();
	const groups = usePaletteGroups(open);
	const [selected, setSelected] = useState("");
	// Every open starts on the first row (cmdk auto-selects only when the
	// controlled value is empty), as in the prototype.
	const [openSeen, setOpenSeen] = useState(open);
	if (openSeen !== open) {
		setOpenSeen(open);
		setSelected("");
	}
	const byValue = useMemo(
		() =>
			new Map<string, PaletteItem>(
				groups.flatMap((g) => g.items.map((i) => [i.value, i] as const)),
			),
		[groups],
	);
	const cli = byValue.get(selected)?.cli;

	const run = (item: PaletteItem) => {
		setOpen(false);
		navigate(item.to);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				showCloseButton={false}
				className="top-[14vh] w-[min(580px,92vw)] max-w-none translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-none"
			>
				<DialogTitle className="sr-only">Command palette</DialogTitle>
				<DialogDescription className="sr-only">
					Search services, projects and actions.
				</DialogDescription>
				<Command
					value={selected}
					onValueChange={setSelected}
					className="rounded-none! p-0"
				>
					<CommandInput
						autoFocus
						placeholder="Type a service, project or command…"
						className="h-10 text-[14px]"
					/>
					<CommandList className="max-h-[360px] p-1.5">
						<CommandEmpty className="py-6 text-center text-[13px] text-muted-foreground">
							No matches
						</CommandEmpty>
						{groups.map((group) => (
							<CommandGroup key={group.heading} heading={group.heading}>
								{group.items.map((item) => (
									<CommandItem
										key={item.value}
										value={item.value}
										keywords={[item.label, ...item.keywords]}
										onSelect={() => run(item)}
										className="h-[38px] gap-2.5 rounded-control px-2.5"
									>
										<ItemIcon icon={item.icon} />
										<span className="flex-1 truncate font-medium text-[13px]">
											{item.label}
										</span>
										{item.sub ? (
											<span className="text-[12px] text-muted-foreground">
												{item.sub}
											</span>
										) : null}
									</CommandItem>
								))}
							</CommandGroup>
						))}
					</CommandList>
				</Command>
				<div className="flex items-center gap-2.5 border-t bg-subtle px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
					{cli ? (
						<>
							<span
								className="max-w-[40%] truncate text-[#a3a3a3]"
								title={cli.cwd}
							>
								{shortPath(cli.cwd)}
							</span>
							<span aria-hidden className="text-[#a3a3a3]">
								$
							</span>
							<code
								data-testid="palette-cli"
								className="min-w-0 flex-1 truncate"
							>
								{cli.command}
							</code>
						</>
					) : (
						<span className="flex-1" />
					)}
					<span className="font-sans">↑↓ ↵ esc</span>
				</div>
			</DialogContent>
		</Dialog>
	);
}
