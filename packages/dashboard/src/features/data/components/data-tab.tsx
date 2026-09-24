import type { ServiceDetail } from "@locastack/server";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/shared/lib/api-error";
import { downloadText } from "@/shared/lib/clipboard";
import { pluralize } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Kbd } from "@/shared/ui/kbd";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { Textarea } from "@/shared/ui/textarea";
import {
	type DataQueryResult,
	dataObjectsQuery,
	runDataQuery,
} from "../api/data.api";
import { csvFileName, toCsv } from "../lib/csv";

/** Props of {@link DataTab}. */
export interface DataTabProps {
	readonly project: string;
	readonly service: ServiceDetail;
	/** Heading of the object list from the catalog (`data.label`), until the list loads. */
	readonly label?: string;
}

/**
 * Meta line of a result: `3 rows in 12 ms`, noting truncation.
 *
 * @param result - Query result.
 * @returns The line.
 */
export function resultMeta(result: DataQueryResult): string {
	const base = `${pluralize(result.rowCount, "row")} in ${result.durationMs} ms`;
	return result.truncated ? `${base}, first ${result.rowCount} shown` : base;
}

/**
 * Data tab: the service's objects (tables, key patterns) on the left, a
 * query editor (⌘↵ runs) and the result grid on the right. One-shot REST:
 * the list loads once while the service runs and is refetched once after
 * each successful Run (DDL shows up), each Run is one request, and Export
 * CSV is built in the browser.
 */
export function DataTab({ project, service, label }: DataTabProps) {
	const running = service.state === "running";
	const objects = useQuery({
		...dataObjectsQuery(project, service.name),
		enabled: running,
	});
	const [selected, setSelected] = useState<string>();
	const [draft, setDraft] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const run = useMutation({
		mutationFn: (query: string) => runDataQuery(project, service.name, query),
		// A query may create or drop objects (DDL): refetch the list once,
		// without holding the result back until it arrives.
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: dataObjectsQuery(project, service.name).queryKey,
				exact: true,
			});
		},
	});
	const list = objects.data?.objects ?? [];
	const current = list.find((o) => o.name === selected) ?? list[0];
	const query = draft ?? current?.defaultQuery ?? "";
	const result = run.data;
	const guard = `${service.name} is not running. Start it to run queries.`;

	const submit = () => {
		if (!running || run.isPending) return;
		if (!query.trim()) {
			toast.error("Query is empty.");
			return;
		}
		run.mutate(query);
	};

	const exportCsv = () => {
		if (!result) return;
		const file = csvFileName(current?.name, service.name);
		downloadText(file, toCsv(result.columns, result.rows), "text/csv");
		toast(`Exported ${pluralize(result.rowCount, "row")} to ${file}`);
	};

	return (
		<div className="flex min-h-[380px] flex-col overflow-hidden rounded-card border sm:flex-row">
			<nav
				aria-label={objects.data?.label ?? label ?? "Objects"}
				className="flex flex-none flex-col gap-0.5 border-b bg-subtle px-2 py-2.5 sm:w-[180px] sm:border-r sm:border-b-0"
			>
				<div className="px-2 pt-0.5 pb-1.5 font-medium text-[11px] text-muted-foreground">
					{objects.data?.label ?? label ?? "Objects"}
				</div>
				{!running ? (
					<div className="px-2 text-[12px] text-muted-foreground">—</div>
				) : objects.isPending ? (
					<Loader2Icon
						aria-label="Loading"
						className="mx-2 size-3.5 animate-spin text-muted-foreground"
					/>
				) : objects.isError ? (
					<div role="alert" className="px-2 text-[12px] text-muted-foreground">
						{errorMessage(objects.error)}
					</div>
				) : list.length === 0 ? (
					<div className="px-2 text-[12px] text-muted-foreground">None yet</div>
				) : (
					list.map((o) => (
						<button
							key={o.name}
							type="button"
							aria-pressed={o === current}
							onClick={() => {
								setSelected(o.name);
								setDraft(null);
								run.reset();
							}}
							className={cn(
								"h-7 truncate rounded-[5px] px-2 text-left font-mono text-[12.5px] hover:bg-[#f0f0f0] dark:hover:bg-muted",
								o === current && "bg-[#f0f0f0] dark:bg-muted",
							)}
						>
							{o.name}
						</button>
					))
				)}
				{objects.data?.truncated ? (
					<div className="px-2 pt-1 text-[11px] text-muted-foreground">
						First {list.length} shown
					</div>
				) : null}
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
				<Textarea
					aria-label="Query"
					spellCheck={false}
					value={query}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							submit();
						}
					}}
					className="min-h-[110px] resize-y rounded-none border-0 border-b px-3.5 py-3 font-mono text-[13px] leading-[1.65] shadow-none focus-visible:ring-0"
				/>
				<div className="flex items-center gap-2 border-b px-3 py-2">
					<Button
						size="sm"
						className="h-7 gap-2 rounded-control px-3 text-[12px]"
						disabled={!running || run.isPending}
						onClick={submit}
					>
						{run.isPending ? "Running…" : "Run"}
						<Kbd
							aria-hidden
							className="bg-transparent font-mono text-[10.5px] text-[#a3a3a3]"
						>
							⌘↵
						</Kbd>
					</Button>
					<span className="flex-1 truncate text-[12px] text-muted-foreground">
						{result ? resultMeta(result) : ""}
					</span>
					{result && result.rowCount > 0 ? (
						<Button
							variant="outline"
							size="sm"
							className="h-7 gap-1.5 rounded-control px-2.5 text-[12px]"
							onClick={exportCsv}
						>
							<DownloadIcon aria-hidden className="size-3.5" />
							Export CSV
						</Button>
					) : null}
				</div>
				{!running ? (
					<div
						role="status"
						className="m-3 rounded-control border px-3 py-2.5 text-[13px]"
					>
						{guard}
					</div>
				) : run.isError ? (
					<div
						role="alert"
						className="m-3 whitespace-pre-wrap rounded-control border border-foreground px-3 py-2.5 font-mono text-[12.5px]"
					>
						{errorMessage(run.error)}
					</div>
				) : result ? (
					<ResultGrid result={result} />
				) : (
					<div className="flex flex-1 items-center justify-center p-6 text-[#a3a3a3] text-[13px]">
						{run.isPending ? "Running…" : "Run a query to see results"}
					</div>
				)}
			</div>
		</div>
	);
}

function ResultGrid({ result }: { readonly result: DataQueryResult }) {
	if (result.rowCount === 0) {
		return (
			<div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">
				No rows
			</div>
		);
	}
	return (
		<div className="max-h-[480px] overflow-auto">
			<Table aria-label="Query results" className="font-mono text-[12.5px]">
				<TableHeader className="sticky top-0 bg-subtle">
					<TableRow>
						{result.columns.map((column, i) => (
							<TableHead
								// biome-ignore lint/suspicious/noArrayIndexKey: column names can repeat
								key={`${column}-${i}`}
								className="h-8 px-3.5 font-medium font-sans text-[11px] text-muted-foreground"
							>
								{column}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{result.rows.map((row, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
						<TableRow key={r}>
							{row.map((cell, c) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: positional cells
								<TableCell key={c} className="whitespace-nowrap px-3.5 py-2">
									{cell}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
