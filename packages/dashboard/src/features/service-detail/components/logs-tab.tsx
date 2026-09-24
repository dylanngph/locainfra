import type { ServiceDetail } from "@locastack/server";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { VList, type VListHandle } from "virtua";
import { StatusDot } from "@/shared/components/status";
import { formatClock } from "@/shared/lib/format";
import { subscribeChannel } from "@/shared/lib/observer/observer";
import {
	EMPTY_LOG_BUFFER,
	type LogEntry,
} from "@/shared/lib/observer/observer-state";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { fetchLogTail } from "../api/one-shot.api";
import { useLogFilter } from "../hooks/use-detail-params";
import { ansiSpans, matchesFilter, parseLogLine } from "../lib/log-line";

/** Log history fetched once (and requested when following). */
export const LOG_TAIL = 200;

const LEVEL_CLASS: Readonly<Record<string, string>> = {
	WARN: "font-semibold text-status-starting-fg",
	ERROR: "font-semibold text-status-error-fg",
};

function LogRow({ entry }: { readonly entry: LogEntry }) {
	if (entry.kind === "skipped") {
		return (
			<div className="py-0.5 text-muted-foreground italic">
				… {entry.count} lines skipped
			</div>
		);
	}
	const { level, message, plain } = parseLogLine(entry.text);
	return (
		<div className="flex gap-3.5 whitespace-pre">
			<span className="w-[58px] flex-none text-[#a3a3a3]">
				{formatClock(entry.at)}
			</span>
			<span
				className={cn(
					"w-10 flex-none text-muted-foreground",
					level ? LEVEL_CLASS[level] : undefined,
				)}
			>
				{level}
			</span>
			<span className="min-w-0 flex-1 truncate" title={plain}>
				{ansiSpans(message).map((span, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reorder
						key={i}
						style={span.color ? { color: span.color } : undefined}
						className={span.bold ? "font-semibold" : undefined}
					>
						{span.text}
					</span>
				))}
			</span>
		</div>
	);
}

/** Props of {@link LogsTab}. */
export interface LogsTabProps {
	/** Project name (for the REST tail). */
	readonly project: string;
	readonly service: ServiceDetail;
	/** Live mode of the project: Follow is switched on and off with it. */
	readonly live: boolean;
}

/**
 * Keeps the container's log buffer filled: while following, `logs:<id>`
 * stays subscribed on the observer socket (tail + stream); otherwise the
 * last {@link LOG_TAIL} lines are fetched once per container over REST
 * (Reload fetches again), so no socket is opened. Turning Follow off keeps
 * what was streamed.
 */
function useLogSource(
	project: string,
	name: string,
	containerId: string | undefined,
	follow: boolean,
) {
	const [loading, setLoading] = useState(false);
	const clearLogs = useObserverStore((s) => s.clearLogs);
	const loadedFor = useRef<string | undefined>(undefined);
	const reload = useCallback(() => {
		if (!containerId) return;
		setLoading(true);
		fetchLogTail(project, name, containerId, LOG_TAIL)
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [project, name, containerId]);
	useEffect(() => {
		if (!containerId) return;
		const first = loadedFor.current !== containerId;
		loadedFor.current = containerId;
		if (!follow) {
			if (first) reload();
			return;
		}
		// The subscription replays the tail: start from an empty buffer.
		clearLogs(containerId);
		return subscribeChannel(`logs:${containerId}`, LOG_TAIL);
	}, [containerId, follow, reload, clearLogs]);
	return { loading, reload };
}

/**
 * Logs tab: the last 200 lines loaded once (Reload refetches), a Follow
 * switch that streams new lines (switched on and off with the project's
 * Live mode), a `?f=` filter and a virtualized pane.
 */
export function LogsTab({ project, service, live }: LogsTabProps) {
	const containerId = service.containerId;
	const running = service.state === "running" || service.state === "starting";
	const [follow, setFollow] = useState(live);
	// Follow tracks Live: turning Live on starts following, turning it off
	// stops (releasing `logs:<id>` so the socket can close). Between Live
	// changes the switch stays a manual choice.
	const [liveSeen, setLiveSeen] = useState(live);
	if (liveSeen !== live) {
		setLiveSeen(live);
		setFollow(live);
	}
	const { loading, reload } = useLogSource(
		project,
		service.name,
		containerId,
		follow,
	);
	const buffer =
		useObserverStore((s) => (containerId ? s.logs[containerId] : undefined)) ??
		EMPTY_LOG_BUFFER;
	const clearLogs = useObserverStore((s) => s.clearLogs);
	const [filter, setFilter] = useLogFilter();
	const followId = useId();
	const entries = buffer.entries;
	const visible = useMemo(
		() =>
			entries.filter(
				(e) =>
					e.kind === "skipped" ||
					(parseLogLine(e.text).level !== null &&
						matchesFilter(e.text, filter)),
			),
		[entries, filter],
	);
	const list = useRef<VListHandle>(null);
	const following = useRef(true);

	useEffect(() => {
		if (following.current && visible.length > 0) {
			list.current?.scrollToIndex(visible.length - 1, { align: "end" });
		}
	}, [visible.length]);

	const state = follow
		? running
			? "Streaming"
			: "Container not running"
		: loading
			? "Loading…"
			: `Last ${LOG_TAIL} lines`;

	return (
		<>
			<div className="flex items-center gap-2">
				<Input
					type="search"
					aria-label="Filter logs"
					placeholder="Filter logs…"
					value={filter}
					onChange={(e) => void setFilter(e.target.value || null)}
					className="h-8 flex-1 rounded-control text-[13px]"
				/>
				<span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
					<StatusDot tone={follow && running ? "running" : "stopped"} />
					{state}
				</span>
				{follow ? null : (
					<Button
						variant="outline"
						className="h-8 rounded-control px-3"
						disabled={!containerId || loading}
						onClick={reload}
					>
						Reload
					</Button>
				)}
				<div className="flex h-8 items-center gap-2 rounded-control border px-2.5">
					<span id={followId} className="text-[13px]">
						Follow
					</span>
					<Switch
						size="sm"
						aria-labelledby={followId}
						checked={follow}
						disabled={!containerId}
						onCheckedChange={setFollow}
					/>
				</div>
				<Button
					variant="outline"
					className="h-8 rounded-control px-3"
					disabled={!containerId}
					onClick={() => {
						if (containerId) clearLogs(containerId);
					}}
				>
					Clear
				</Button>
			</div>
			<div
				role="log"
				aria-live="off"
				className="h-[380px] rounded-card border bg-subtle px-3.5 py-3 font-mono text-[#262626] text-[12px] leading-[1.75]"
			>
				{visible.length ? (
					<VList
						ref={list}
						style={{ height: "100%" }}
						onScroll={(offset) => {
							const handle = list.current;
							if (!handle) return;
							following.current =
								offset + handle.viewportSize >= handle.scrollSize - 24;
						}}
					>
						{visible.map((entry) => (
							<LogRow key={entry.id} entry={entry} />
						))}
					</VList>
				) : (
					<div className="text-muted-foreground">
						{loading
							? "Loading…"
							: entries.length && filter
								? "No lines match the filter."
								: "No log lines."}
					</div>
				)}
			</div>
		</>
	);
}
