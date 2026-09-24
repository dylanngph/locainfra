import type { Progress } from "@locastack/server";
import { CircleCheckIcon, Loader2Icon, OctagonXIcon } from "lucide-react";
import { useObserverStore } from "@/shared/lib/observer/observer-store";

const NO_EVENTS: readonly Progress[] = [];

/** Props of {@link OpToast}. */
export interface OpToastProps {
	/** Operation id (`op:<opId>` channel). */
	readonly opId: string;
	/** Headline, e.g. "Starting main-db…". */
	readonly title: string;
}

/**
 * Toast body that follows an operation's progress events: headline, latest
 * step and a progress line (determinate when the op reports `percent`).
 */
export function OpToast({ opId, title }: OpToastProps) {
	const events = useObserverStore((s) => s.ops[opId] ?? NO_EVENTS);
	const terminal = events.find((e) => e.kind === "done" || e.kind === "error");
	const latest = [...events].reverse().find((e) => e.kind !== "log");
	const percent = [...events]
		.reverse()
		.find((e) => typeof e.percent === "number")?.percent;
	const failed = terminal?.kind === "error";
	const detail = terminal
		? (terminal.error?.message ?? terminal.message)
		: latest?.message;

	return (
		<div
			role="status"
			className="flex w-[340px] flex-col gap-2 rounded-lg bg-[#0a0a0a] px-3.5 py-2.5 text-[13px] text-[#fafafa] shadow-[0_8px_24px_rgba(0,0,0,.2)]"
		>
			<div className="flex items-center gap-2">
				{terminal ? (
					failed ? (
						<OctagonXIcon className="size-4 text-red-400" aria-hidden />
					) : (
						<CircleCheckIcon className="size-4 text-green-400" aria-hidden />
					)
				) : (
					<Loader2Icon className="size-4 animate-spin" aria-hidden />
				)}
				<span className="font-medium">{title}</span>
			</div>
			{detail ? (
				<span
					className={
						failed ? "text-[12px] text-red-300" : "text-[12px] text-[#a3a3a3]"
					}
				>
					{detail}
				</span>
			) : null}
			<div className="h-0.5 overflow-hidden rounded-full bg-white/15">
				{terminal ? (
					<div
						className={
							failed ? "h-full w-full bg-red-400" : "h-full w-full bg-green-400"
						}
					/>
				) : typeof percent === "number" ? (
					<div
						className="h-full bg-white transition-[width] duration-300"
						style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
					/>
				) : (
					<div className="h-full w-1/3 animate-[ls-indeterminate_1.2s_ease-in-out_infinite] bg-white" />
				)}
			</div>
		</div>
	);
}
