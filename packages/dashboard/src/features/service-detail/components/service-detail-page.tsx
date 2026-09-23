import { useQuery } from "@tanstack/react-query";
import { ClockIcon, PackageIcon, PlugIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { catalogQuery } from "@/features/catalog/api/catalog.queries";
import { projectQuery } from "@/features/projects/api/projects.queries";
import {
	RemoveServiceDialog,
	type RemoveTarget,
} from "@/features/services/components/remove-service-dialog";
import { useServiceActions } from "@/features/services/hooks/use-service-actions";
import { SnapshotsTab } from "@/features/snapshots/components/snapshots-tab";
import { snapshotVolumeOf } from "@/features/snapshots/lib/snapshot-volume";
import { BrandChip } from "@/shared/components/brand-chip";
import { CliHint } from "@/shared/components/cli-hint";
import { MetaChip } from "@/shared/components/meta-chip";
import { STATE_LABEL, StatusPill, toneOf } from "@/shared/components/status";
import { useChannel } from "@/shared/hooks/use-channel";
import { useNow } from "@/shared/hooks/use-now";
import { formatUptime } from "@/shared/lib/format";
import { useLiveMode } from "@/shared/lib/live/live-mode";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import {
	DETAIL_TABS,
	type DetailTab,
	useDetailTab,
} from "../hooks/use-detail-params";
import { useLiveService } from "../hooks/use-live-service";
import { ConnectTab } from "./connect-tab";
import { MetricsTab } from "./metrics-tab";

const LogsTab = lazy(async () => ({
	default: (await import("./logs-tab")).LogsTab,
}));
const DataTab = lazy(async () => ({
	default: (await import("@/features/data/components/data-tab")).DataTab,
}));

const TAB_LABEL: Readonly<Record<DetailTab, string>> = {
	connect: "Connect",
	data: "Data",
	logs: "Logs",
	metrics: "Metrics",
	snapshots: "Snapshots",
};

/** `/p/:project/s/:service`: one instance with Connect / Data / Logs / Metrics / Snapshots. */
export function ServiceDetailPage() {
	const { project = "", service: name = "" } = useParams();
	const service = useLiveService(project, name);
	const { data: catalog } = useQuery(catalogQuery());
	const { data: projectDetail } = useQuery(projectQuery(project));
	const definition = catalog?.definitions.find((d) => d.id === service.type);
	const [requestedTab, setTab] = useDetailTab();
	const actions = useServiceActions(project);
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState<RemoveTarget | null>(null);
	const navigate = useNavigate();
	const live = useLiveMode(project);
	const now = useNow();
	const running = service.state === "running";
	// Live mode streams this service's metrics while it runs.
	useChannel(
		live && running && service.containerId
			? `stats:${service.containerId}`
			: null,
	);
	const active = running || service.state === "starting";
	const suggested = service.problem?.suggestedPort;
	const troubled =
		service.state === "port-conflict" || service.state === "error";
	// Data: only for catalog data.kind sql/redis. Snapshots: services that
	// keep exactly one data volume (what the server can archive), or a seed
	// block (the Seed button lives there). Until the catalog loads every tab
	// shows, so a ?tab= link does not jump.
	const dataKind = definition?.data?.kind;
	const seed = definition?.seed
		? projectDetail?.stack.file.services[service.name]?.seed
		: undefined;
	const snapshotVolume = snapshotVolumeOf(service, definition);
	const tabs = DETAIL_TABS.filter((t) =>
		t === "data"
			? !definition || dataKind === "sql" || dataKind === "redis"
			: t === "snapshots"
				? !definition || snapshotVolume === "ok" || Boolean(definition.seed)
				: true,
	);
	const tab: DetailTab = tabs.includes(requestedTab) ? requestedTab : "connect";

	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				<BrandChip type={service.type} icon={definition?.icon} size="xl" />
				<div className="min-w-[220px] flex-1">
					<div className="flex items-center gap-2.5">
						<h1 className="m-0 font-semibold text-[22px] tracking-[-0.02em]">
							{service.name}
						</h1>
						<StatusPill
							tone={toneOf(service.state)}
							label={STATE_LABEL[service.state]}
						/>
					</div>
					<div className="mt-1.5 flex flex-wrap gap-1.5">
						<MetaChip icon={PackageIcon}>{service.image}</MetaChip>
						<MetaChip icon={PlugIcon}>127.0.0.1:{service.hostPort}</MetaChip>
						<MetaChip icon={ClockIcon}>
							{running
								? `Up ${formatUptime(service.startedAt, now)}`
								: "Not running"}
						</MetaChip>
					</div>
				</div>
				<Button
					variant="outline"
					className="h-8 rounded-control px-3"
					disabled={busy}
					onClick={() => void act(() => actions.restart(service.name))}
				>
					Restart
				</Button>
				<Button
					className="h-8 rounded-control px-3"
					disabled={busy}
					onClick={() =>
						void act(() =>
							active ? actions.stop(service.name) : actions.start(service.name),
						)
					}
				>
					{active ? "Stop" : "Start"}
				</Button>
				<Button
					variant="outline"
					className="h-8 gap-1.5 rounded-control px-3"
					disabled={busy}
					onClick={() =>
						setRemoving({ name: service.name, persist: service.persist })
					}
				>
					<Trash2Icon aria-hidden className="size-3.5" />
					Remove
				</Button>
			</div>
			{troubled ? (
				<div
					role="alert"
					className="flex items-center gap-3 rounded-lg border border-foreground px-3.5 py-2.5 text-[13px]"
				>
					<span className="font-semibold" aria-hidden>
						!
					</span>
					<span className="flex-1">
						{service.problem?.message ?? "The container exited with an error."}
					</span>
					{suggested ? (
						<Button
							size="sm"
							className="h-7 rounded-control text-[12px]"
							disabled={busy}
							onClick={() =>
								void act(() => actions.movePort(service.name, suggested))
							}
						>
							Use port {suggested}
						</Button>
					) : null}
				</div>
			) : null}
			<Tabs
				value={tab}
				onValueChange={(value) => {
					if (
						typeof value === "string" &&
						(DETAIL_TABS as readonly string[]).includes(value)
					)
						void setTab(value === "connect" ? null : (value as DetailTab));
				}}
				className="gap-[18px]"
			>
				<TabsList
					variant="line"
					className="h-auto w-full justify-start gap-1 border-b p-0"
				>
					{tabs.map((t) => (
						<TabsTrigger
							key={t}
							value={t}
							className="h-9 flex-none px-3 text-[13px]"
						>
							{TAB_LABEL[t]}
						</TabsTrigger>
					))}
				</TabsList>
				<TabsContent value="connect" className="flex flex-col gap-[18px]">
					<ConnectTab
						project={project}
						service={service}
						definition={definition}
					/>
				</TabsContent>
				{tabs.includes("data") ? (
					<TabsContent value="data">
						<Suspense
							fallback={<Skeleton className="h-[380px] rounded-card" />}
						>
							<DataTab
								project={project}
								service={service}
								label={definition?.data?.label}
							/>
						</Suspense>
					</TabsContent>
				) : null}
				<TabsContent value="logs" className="flex flex-col gap-3">
					<Suspense fallback={<Skeleton className="h-[420px] rounded-card" />}>
						<LogsTab project={project} service={service} live={live} />
					</Suspense>
				</TabsContent>
				<TabsContent value="metrics" className="flex flex-col gap-3.5">
					<MetricsTab project={project} service={service} live={live} />
				</TabsContent>
				{tabs.includes("snapshots") ? (
					<TabsContent value="snapshots" className="flex flex-col gap-3">
						<SnapshotsTab
							key={service.name}
							project={project}
							service={service}
							volume={snapshotVolume}
							seed={seed}
						/>
					</TabsContent>
				) : null}
			</Tabs>
			<RemoveServiceDialog
				project={project}
				target={removing}
				onClose={() => setRemoving(null)}
				onRemoved={() => navigate(`/p/${project}`)}
			/>
			{projectDetail && !active ? (
				<CliHint
					cwd={projectDetail.stack.root}
					command={`locainfra up --service ${service.name}`}
				/>
			) : null}
		</>
	);
}
