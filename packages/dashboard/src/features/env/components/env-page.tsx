import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { projectQuery } from "@/features/projects/api/projects.queries";
import { CliHint } from "@/shared/components/cli-hint";
import { PageHeader } from "@/shared/components/page-header";
import { Segmented } from "@/shared/components/segmented";
import { errorMessage } from "@/shared/lib/api-error";
import { copyText, downloadText } from "@/shared/lib/clipboard";
import { pluralize } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Skeleton } from "@/shared/ui/skeleton";
import { Switch } from "@/shared/ui/switch";
import { revealedEnvText, writeEnv } from "../api/env.api";
import { type EnvFormat, envQuery } from "../api/env.queries";
import { useEnvFormat } from "../hooks/use-env-format";

const FORMAT_OPTIONS: readonly { value: EnvFormat; label: string }[] = [
	{ value: "dotenv", label: ".env" },
	{ value: "shell", label: "Shell export" },
	{ value: "json", label: "JSON" },
];

const DOWNLOAD_NAME: Readonly<Record<EnvFormat, string>> = {
	dotenv: ".env",
	shell: "env.sh",
	json: "env.json",
};

/** `/p/:project/env`: exported variables in .env / shell / JSON, reveal, write, copy, download. */
export function EnvPage() {
	const { project = "" } = useParams();
	const [format, setFormat] = useEnvFormat();
	const [reveal, setReveal] = useState(false);
	const [writing, setWriting] = useState(false);
	const { data: detail } = useQuery(projectQuery(project));
	const { data, isError, error } = useQuery({
		...envQuery(project, format, reveal),
		placeholderData: keepPreviousData,
	});

	const write = async () => {
		setWriting(true);
		try {
			const result = await writeEnv(project);
			toast(`Wrote ${pluralize(result.count, "variable")} to ${result.path}`);
		} catch (e) {
			toast.error(errorMessage(e));
		} finally {
			setWriting(false);
		}
	};
	const revealed = async (fn: (text: string) => unknown) => {
		try {
			fn(await revealedEnvText(project, format));
		} catch (e) {
			toast.error(errorMessage(e));
		}
	};

	const lines = data ? data.text.split("\n") : [];
	return (
		<>
			<PageHeader
				title="Environment"
				subtitle={
					data
						? `${pluralize(data.lines.length, "variable")} generated from ${pluralize(data.serviceCount, "service")} in ${project}. Values update when ports or credentials change.`
						: " "
				}
			/>
			<div className="flex flex-wrap items-center gap-2.5">
				<Segmented
					label="Format"
					value={format}
					options={FORMAT_OPTIONS}
					onChange={(value) =>
						void setFormat(value === "dotenv" ? null : value)
					}
				/>
				<div className="flex-1" />
				<div className="flex h-8 items-center gap-2 px-2.5">
					<Switch
						id="reveal-secrets"
						checked={reveal}
						onCheckedChange={setReveal}
					/>
					<Label
						htmlFor="reveal-secrets"
						className="cursor-pointer font-normal text-[13px]"
					>
						Reveal secrets
					</Label>
				</div>
			</div>
			{isError ? (
				<div className="rounded-card border p-4 text-[13px] text-muted-foreground">
					{errorMessage(error)}
				</div>
			) : data ? (
				<pre
					data-testid="env-preview"
					className="m-0 overflow-auto rounded-card border bg-[#fcfcfc] px-4 py-3.5 font-mono text-[12.5px] leading-[1.8]"
				>
					{data.lines.length === 0 && data.format !== "json" ? (
						<span className="text-[#a3a3a3]"># no services yet</span>
					) : (
						lines.map((line, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: preview lines are positional
								key={i}
								className={
									line.startsWith("#") ? "text-[#a3a3a3]" : "text-[#262626]"
								}
							>
								{line || " "}
							</div>
						))
					)}
				</pre>
			) : (
				<Skeleton className="h-40 rounded-card" />
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					className="h-8 rounded-control px-3"
					disabled={writing || !data}
					onClick={() => void write()}
				>
					Write to ./{data?.file ?? ".env"}
				</Button>
				<Button
					variant="outline"
					className="h-8 rounded-control px-3"
					disabled={!data}
					onClick={() =>
						void revealed((text) => copyText(text, "Environment copied"))
					}
				>
					Copy
				</Button>
				<Button
					variant="outline"
					className="h-8 rounded-control px-3"
					disabled={!data}
					onClick={() =>
						void revealed((text) => downloadText(DOWNLOAD_NAME[format], text))
					}
				>
					Download
				</Button>
			</div>
			{detail ? (
				<CliHint
					cwd={detail.stack.root}
					command={`locainfra env${format === "dotenv" ? "" : ` --format ${format}`}`}
				/>
			) : null}
		</>
	);
}
