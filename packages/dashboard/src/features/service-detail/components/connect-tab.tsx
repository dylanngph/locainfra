import type { ServiceDefinition, ServiceDetail } from "@locastack/server";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { revealedPrimaryUrl } from "@/features/services/api/services.api";
import { connectionQuery } from "@/features/services/api/services.queries";
import { api, unwrap } from "@/shared/lib/api";
import { errorMessage } from "@/shared/lib/api-error";
import { copyText } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import {
	type SnippetLang,
	useDetailTab,
	useSnippetLang,
} from "../hooks/use-detail-params";
import { RotateSecretDialog, type RotateTarget } from "./rotate-secret-dialog";

const LANG_LABEL: Readonly<Record<SnippetLang, string>> = {
	env: ".env",
	node: "Node",
	python: "Python",
	go: "Go",
};

/** Props of {@link ConnectTab}. */
export interface ConnectTabProps {
	readonly project: string;
	readonly service: ServiceDetail;
	/** Catalog definition (secret flags such as `bakedIntoVolume`). */
	readonly definition?: ServiceDefinition;
}

/** Connect tab: connection string, details grid, Rotate per secret and "Use in code" snippets. */
export function ConnectTab({ project, service, definition }: ConnectTabProps) {
	const [reveal, setReveal] = useState(false);
	const [lang, setLang] = useSnippetLang();
	const [, setTab] = useDetailTab();
	const [rotating, setRotating] = useState<RotateTarget | null>(null);
	const isBaked = (key: string) =>
		service.persist === "volume" &&
		definition?.secretOptions?.[key]?.bakedIntoVolume === true;
	const { data, isError, error } = useQuery({
		...connectionQuery(project, service.name, reveal),
		placeholderData: keepPreviousData,
	});

	if (isError) {
		return (
			<div className="rounded-card border p-4 text-[13px] text-muted-foreground">
				{errorMessage(error)}
			</div>
		);
	}
	if (!data) return <Skeleton className="h-40 rounded-card" />;

	const langs = (Object.keys(LANG_LABEL) as SnippetLang[]).filter(
		(l) => l === "env" || data.snippets[l],
	);
	const active: SnippetLang = langs.includes(lang) ? lang : "env";
	const code = data.snippets[active] ?? "";

	const copyConnection = async () => {
		try {
			await copyText(
				await revealedPrimaryUrl(project, service.name),
				"Connection string copied",
			);
		} catch (e) {
			toast.error(errorMessage(e));
		}
	};
	const copyCode = async () => {
		try {
			const text =
				active === "env"
					? (
							await unwrap(
								api.api
									.projects({ project })
									.services({ name: service.name })
									.connection.get({ query: { reveal: true } }),
							)
						).snippets.env
					: code;
			await copyText(text, "Snippet copied");
		} catch (e) {
			toast.error(errorMessage(e));
		}
	};

	return (
		<>
			<section className="flex flex-col gap-2.5 rounded-card border p-4">
				<div className="font-medium text-[13px]">Connection string</div>
				<div className="flex gap-2">
					<div
						title={data.primary.key}
						className="flex h-9 min-w-0 flex-1 items-center truncate rounded-control border bg-subtle px-3 font-mono text-[12.5px]"
					>
						<span className="truncate">{data.primary.value}</span>
					</div>
					<Button
						variant="outline"
						className="h-9 rounded-control px-3"
						onClick={() => setReveal((r) => !r)}
					>
						{reveal ? "Hide" : "Reveal"}
					</Button>
					<Button
						className="h-9 rounded-control px-3"
						onClick={() => void copyConnection()}
					>
						Copy
					</Button>
				</div>
				<dl className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-px overflow-hidden rounded-lg border border-hairline bg-hairline">
					{data.details.map((d, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: labels repeat (several secrets)
						<div key={`${d.k}-${i}`} className="bg-background px-3 py-2.5">
							<dt className="text-[11px] text-muted-foreground">{d.k}</dt>
							<dd className="truncate font-mono text-[12.5px]">{d.v}</dd>
						</div>
					))}
				</dl>
				{service.secretNames.length ? (
					<ul aria-label="Secrets" className="mt-1 flex flex-col gap-1.5">
						{service.secretNames.map((key) => (
							<li key={key} className="flex items-center gap-2 text-[12px]">
								<span className="min-w-0 flex-1 truncate font-mono">{key}</span>
								{isBaked(key) ? (
									<span className="text-muted-foreground">
										Stored in the data volume
									</span>
								) : null}
								<Button
									variant="outline"
									size="xs"
									className="h-[26px] rounded-[5px] text-[12px]"
									aria-label={`Rotate ${key}`}
									onClick={() => setRotating({ key, baked: isBaked(key) })}
								>
									Rotate
								</Button>
							</li>
						))}
					</ul>
				) : null}
			</section>
			<RotateSecretDialog
				project={project}
				service={service.name}
				target={rotating}
				onClose={() => setRotating(null)}
				onSnapshotFirst={
					service.persist === "volume"
						? () => void setTab("snapshots")
						: undefined
				}
			/>
			<section className="overflow-hidden rounded-card border">
				<div className="flex items-center gap-1 border-b bg-background px-2.5 py-2">
					<span className="flex-1 px-1.5 font-medium text-[13px]">
						Use in code
					</span>
					{langs.map((l) => (
						<button
							key={l}
							type="button"
							aria-pressed={l === active}
							onClick={() => void setLang(l === "env" ? null : l)}
							className={cn(
								"h-[26px] rounded-[5px] border px-2.5 font-medium text-[12px] hover:bg-muted",
								l === active ? "border-border bg-muted" : "border-transparent",
							)}
						>
							{LANG_LABEL[l]}
						</button>
					))}
					<Button
						variant="outline"
						size="xs"
						className="ml-1.5 h-[26px] rounded-[5px] text-[12px]"
						onClick={() => void copyCode()}
					>
						Copy
					</Button>
				</div>
				<pre className="m-0 whitespace-pre-wrap bg-[#fcfcfc] px-4 py-3.5 font-mono text-[#262626] text-[12.5px] leading-[1.7]">
					{code}
				</pre>
			</section>
		</>
	);
}
