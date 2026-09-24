import type { ServiceDetail, StatsSample } from "@locastack/server";
import { type ReactNode, useEffect } from "react";
import { formatCpu, formatMem } from "@/shared/lib/format";
import { useLiveModeStore } from "@/shared/lib/live/live-mode";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import { Button } from "@/shared/ui/button";
import { fetchStatsOnce } from "../api/one-shot.api";

/** Bars shown per chart (≈ 36 s at one sample per 1.5 s). */
export const METRIC_BARS = 24;
const NO_SAMPLES: readonly StatsSample[] = [];

interface BarsProps {
	readonly label: string;
	readonly values: readonly number[];
	readonly max: number;
}

function Bars({ label, values, max }: BarsProps) {
	const padded = [
		...Array.from(
			{ length: Math.max(0, METRIC_BARS - values.length) },
			() => 0,
		),
		...values,
	];
	return (
		<div
			role="img"
			aria-label={label}
			className="flex h-[90px] items-end gap-[3px]"
		>
			{padded.map((v, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional slots
					key={i}
					className="flex-1 rounded-t-[2px] bg-foreground transition-[height] duration-[400ms]"
					style={{
						height: `${Math.max(2, Math.min(100, (v / max) * 100))}%`,
						opacity: 0.35 + 0.65 * (i / padded.length),
					}}
				/>
			))}
		</div>
	);
}

/**
 * Top of the memory bar scale: 25% above the highest recent sample, so
 * changes stay visible (scaling to the container limit, often several GB,
 * flattens a 20 MB database to nothing).
 *
 * @param mem - Recent memory samples in bytes.
 * @returns The scale maximum (at least 1).
 */
export function memoryScale(mem: readonly number[]): number {
	return Math.max(1, ...mem) * 1.25;
}

/** Props of {@link MetricsTab}. */
export interface MetricsTabProps {
	readonly project: string;
	readonly service: ServiceDetail;
	/**
	 * Live mode: the page keeps `stats:<containerId>` subscribed and the tab
	 * draws charts. Off: one-shot numbers and a hint to turn Live on.
	 */
	readonly live: boolean;
}

function LiveHint({ onEnable }: { readonly onEnable: () => void }) {
	return (
		<div className="flex h-[90px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-[12px] text-muted-foreground">
			Turn on Live for charts
			<Button
				variant="outline"
				size="xs"
				className="h-6 rounded-[5px] text-[12px]"
				onClick={onEnable}
			>
				Turn on Live
			</Button>
		</div>
	);
}

interface MetricCardProps {
	readonly label: string;
	readonly value: string;
	readonly footer: string;
	readonly children: ReactNode;
}

function MetricCard({ label, value, footer, children }: MetricCardProps) {
	return (
		<section className="flex flex-col gap-3 rounded-card border p-4">
			<div className="flex items-baseline">
				<span className="flex-1 text-[13px] text-muted-foreground">
					{label}
				</span>
				<span className="font-semibold text-[22px] tracking-[-0.02em]">
					{value}
				</span>
			</div>
			{children}
			<div className="text-[#a3a3a3] text-[11px]">{footer}</div>
		</section>
	);
}

/**
 * Metrics tab: CPU and memory. With Live on, bars of the last 24 streamed
 * samples; with Live off, the last-known numbers (fetched once on open)
 * and a "Turn on Live for charts" hint. Plus the container facts table.
 */
export function MetricsTab({ project, service, live }: MetricsTabProps) {
	const containerId = service.containerId;
	const running = service.state === "running";
	const setLive = useLiveModeStore((s) => s.setLive);
	useEffect(() => {
		if (!live && running && containerId)
			fetchStatsOnce(project, service.name, containerId).catch(() => {});
	}, [live, running, project, service.name, containerId]);
	const samples =
		useObserverStore((s) => (containerId ? s.stats[containerId] : undefined)) ??
		NO_SAMPLES;
	const recent = running ? samples.slice(-METRIC_BARS) : [];
	const latest = recent.at(-1);
	const cpuNow =
		latest?.cpuPercent ?? (running ? service.cpuPercent : undefined);
	const memNow = latest?.memBytes ?? (running ? service.memBytes : undefined);
	const cpu = recent.map((s) => s.cpuPercent);
	const mem = recent.map((s) => s.memBytes);
	const memLimit = latest?.memLimitBytes ?? 0;
	const volume = service.volumes.map((v) => v.name).join(", ");
	const charts = live && running;
	const span = charts ? "Last 36 seconds" : "Last known";
	const enable = () => setLive(project, true);

	const info: readonly [string, string][] = [
		["Image", service.image],
		["Container", service.containerName],
		["Network", service.network],
		["Volume", volume || "none (ephemeral)"],
		[
			"Port mapping",
			`127.0.0.1:${service.hostPort} → ${service.containerPort}`,
		],
	];

	return (
		<>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
				<MetricCard
					label="CPU"
					value={cpuNow !== undefined ? formatCpu(cpuNow) : "—"}
					footer={`${span}, percent of one core`}
				>
					{charts ? (
						<Bars label="CPU usage" values={cpu} max={Math.max(10, ...cpu)} />
					) : running ? (
						<LiveHint onEnable={enable} />
					) : null}
				</MetricCard>
				<MetricCard
					label="Memory"
					value={memNow !== undefined ? formatMem(memNow) : "—"}
					footer={`${span}${memLimit > 0 ? `, limit ${formatMem(memLimit)}` : ""}`}
				>
					{charts ? (
						<Bars label="Memory usage" values={mem} max={memoryScale(mem)} />
					) : running ? (
						<LiveHint onEnable={enable} />
					) : null}
				</MetricCard>
			</div>
			{!running ? (
				<p className="text-[12px] text-muted-foreground">
					Start the service to see resource usage.
				</p>
			) : null}
			<dl className="overflow-hidden rounded-card border">
				{info.map(([k, v], i) => (
					<div
						key={k}
						className={
							i
								? "flex border-hairline border-t px-4 py-2.5"
								: "flex px-4 py-2.5"
						}
					>
						<dt className="w-40 flex-none text-[13px] text-muted-foreground">
							{k}
						</dt>
						<dd className="min-w-0 truncate font-mono text-[12.5px]">{v}</dd>
					</div>
				))}
			</dl>
		</>
	);
}
