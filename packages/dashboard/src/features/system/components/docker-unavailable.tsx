import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import {
	CircleAlertIcon,
	CircleXIcon,
	ContainerIcon,
	Loader2Icon,
	PlayIcon,
	RefreshCwIcon,
	TerminalIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { CliHint } from "@/shared/components/cli-hint";
import { cn } from "@/shared/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/shared/ui/card";
import type { SetupPlan, SystemCheck, SystemSetup } from "../api/system.api";
import { SYSTEM_KEY } from "../api/system.queries";
import { useStartDocker } from "../hooks/use-start-docker";
import {
	canStartFromDashboard,
	formatStep,
	RUNTIME_LABEL,
	SETUP_COMMAND,
	setupCommandFor,
	unavailableTitle,
} from "../lib/setup-copy";

/** Props of {@link DockerUnavailable}. */
export interface DockerUnavailableProps {
	/** Doctor report (with at least one failing check) and the remedy plan. */
	readonly setup: SystemSetup;
}

/**
 * Full-page replacement of every route while Docker is unusable: why (the
 * failing doctor checks and their fixes), then the remedy: a **Start
 * Docker** button when an installed runtime is only stopped, else the
 * copyable `locastack setup` command with the plan's steps listed read-only.
 * **Re-check** re-fetches; nothing polls.
 */
export function DockerUnavailable({ setup }: DockerUnavailableProps) {
	const { doctor, plan } = setup;
	const problems = doctor.checks.filter((c) => c.status !== "ok");
	const startable = canStartFromDashboard(plan);
	const title = unavailableTitle(setup);

	return (
		<main className="flex flex-1 justify-center px-4 py-12">
			<Card
				className="h-fit w-full max-w-[600px] rounded-card"
				aria-labelledby="docker-unavailable-title"
			>
				<CardHeader className="gap-1.5">
					<div className="mb-1 flex size-9 items-center justify-center rounded-control border bg-subtle">
						<ContainerIcon className="size-[18px]" aria-hidden />
					</div>
					<CardTitle>
						<h1
							id="docker-unavailable-title"
							className="font-semibold text-[18px] tracking-[-0.01em]"
						>
							{title}
						</h1>
					</CardTitle>
					<CardDescription className="text-[13px]">
						{plan.reason}
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-5">
					{problems.length > 0 ? <CheckList checks={problems} /> : null}
					{startable ? (
						<StartSection plan={plan} />
					) : plan.kind === "unsupported" ? (
						<ManualSection plan={plan} />
					) : (
						<TerminalSection plan={plan} />
					)}
				</CardContent>
				<CardFooter className="justify-between gap-3">
					<span className="text-[12px] text-muted-foreground">
						LocaStack needs a running Docker daemon with the Compose plugin.
					</span>
					<RecheckButton />
				</CardFooter>
			</Card>
		</main>
	);
}

const CHECK_ICON = {
	fail: <CircleXIcon className="size-4 text-status-error" aria-hidden />,
	warn: (
		<TriangleAlertIcon className="size-4 text-status-starting" aria-hidden />
	),
	ok: null,
} as const;

/** The failing (and warning) doctor checks with their fix hints. */
function CheckList({ checks }: { readonly checks: readonly SystemCheck[] }) {
	return (
		<ul aria-label="Failing checks" className="flex flex-col gap-2.5">
			{checks.map((check) => (
				<li key={check.id} className="flex gap-2.5">
					<span className="mt-px flex-none">{CHECK_ICON[check.status]}</span>
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="font-medium text-[13px]">
							{check.label}
							{check.detail ? (
								<span className="font-normal text-muted-foreground">
									{" "}
									— {check.detail}
								</span>
							) : null}
						</span>
						{check.fix ? (
							<span className="text-[12px] text-muted-foreground">
								{check.fix}
							</span>
						) : null}
					</div>
				</li>
			))}
		</ul>
	);
}

/** Read-only list of a plan's commands, exactly as they would run. */
function StepList({
	plan,
	label,
}: {
	readonly plan: SetupPlan;
	readonly label: string;
}) {
	return (
		<ol aria-label={label} className="flex flex-col gap-2">
			{plan.steps.map((step, i) => (
				<li key={step.id} className="flex gap-2.5 text-[12.5px]">
					<span className="w-4 flex-none text-right text-muted-foreground tabular-nums">
						{i + 1}.
					</span>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<span>{step.title}</span>
						<code className="block overflow-x-auto whitespace-pre rounded-control border bg-subtle px-2.5 py-1.5 font-mono text-[#404040] text-[12px]">
							{formatStep(step)}
						</code>
						{step.remoteScript ? (
							<span className="text-[12px] text-muted-foreground">
								Downloaded from {step.remoteScript.url} first; inspect it with{" "}
								<code className="font-mono">
									{step.remoteScript.inspectHint}
								</code>{" "}
								before it runs.
							</span>
						) : null}
						{step.note ? (
							<span className="text-[12px] text-muted-foreground">
								{step.note}
							</span>
						) : null}
					</div>
				</li>
			))}
		</ol>
	);
}

/** Start Docker: the command it runs, the button, the last failure. */
function StartSection({ plan }: { readonly plan: SetupPlan }) {
	const { starting, failure, start } = useStartDocker();
	const runtime = plan.provider ? RUNTIME_LABEL[plan.provider] : "Docker";
	return (
		<section aria-label="Start Docker" className="flex flex-col gap-3">
			<StepList plan={plan} label="Commands Start Docker runs" />
			<div className="flex items-center gap-3">
				<Button
					onClick={() => void start(plan.provider)}
					disabled={starting}
					className="gap-1.5 rounded-control"
				>
					{starting ? (
						<Loader2Icon className="animate-spin" aria-hidden />
					) : (
						<PlayIcon aria-hidden />
					)}
					{starting ? "Starting…" : "Start Docker"}
				</Button>
				<span className="text-[12px] text-muted-foreground">
					Starts {runtime} on this machine. Nothing is installed.
				</span>
			</div>
			{failure ? (
				<Alert variant="destructive">
					<CircleAlertIcon aria-hidden />
					<AlertTitle>Docker did not start</AlertTitle>
					<AlertDescription>
						<p>{failure.message}</p>
						{failure.fix ? <p>{failure.fix}</p> : null}
					</AlertDescription>
				</Alert>
			) : null}
		</section>
	);
}

/** Install (or a sudo start): the copyable `locastack setup` and what it will run. */
function TerminalSection({ plan }: { readonly plan: SetupPlan }) {
	return (
		<section aria-label="Run in your terminal" className="flex flex-col gap-3">
			<div className="flex items-center gap-2 font-medium text-[13px]">
				<TerminalIcon className="size-4" aria-hidden />
				Run this in your terminal
			</div>
			<CliHint command={SETUP_COMMAND} />
			<p className="text-[12px] text-muted-foreground">
				It shows every command and asks before running anything
				{plan.steps.some((step) => step.sudo)
					? " (some steps need your password)"
					: ""}
				.{plan.steps.length > 0 ? " On this machine it will run:" : ""}
			</p>
			{plan.steps.length > 0 ? (
				<StepList plan={plan} label="Setup steps" />
			) : null}
			{plan.alternatives.length > 0 ? (
				<p className="text-[12px] text-muted-foreground">
					Prefer another runtime?{" "}
					{plan.alternatives.map((alt, i) => (
						<span key={alt}>
							{i > 0 ? ", " : ""}
							{RUNTIME_LABEL[alt]}:{" "}
							<code className="font-mono">{setupCommandFor(alt)}</code>
						</span>
					))}
				</p>
			) : null}
			{plan.postNotes.length > 0 ? (
				<ul
					aria-label="Afterwards"
					className="list-disc pl-5 text-[12px] text-muted-foreground"
				>
					{plan.postNotes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

/** No automated remedy: the manual instructions (a context switch, an update or an install). */
function ManualSection({ plan }: { readonly plan: SetupPlan }) {
	return (
		<Alert>
			<CircleAlertIcon aria-hidden />
			<AlertTitle>Fix it by hand</AlertTitle>
			<AlertDescription>
				{plan.postNotes.length > 0 ? (
					<ul className="list-disc pl-4">
						{plan.postNotes.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
				) : (
					<p>
						Install Docker with the Compose plugin, start it, then re-check.
					</p>
				)}
			</AlertDescription>
		</Alert>
	);
}

/** Re-fetches `GET /api/system` and `GET /api/system/setup` once. */
function RecheckButton() {
	const queryClient = useQueryClient();
	const fetching = useIsFetching({ queryKey: SYSTEM_KEY }) > 0;
	return (
		<Button
			variant="outline"
			size="sm"
			className="gap-1.5 rounded-control"
			disabled={fetching}
			onClick={() =>
				void queryClient.invalidateQueries({ queryKey: SYSTEM_KEY })
			}
		>
			<RefreshCwIcon className={cn(fetching && "animate-spin")} aria-hidden />
			Re-check
		</Button>
	);
}
