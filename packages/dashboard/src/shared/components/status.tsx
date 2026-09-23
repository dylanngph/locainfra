import type { ServiceState } from "@locainfra/server";
import { cn } from "@/shared/lib/utils";

/** Visual tone of a status indicator. */
export type StatusTone = "running" | "starting" | "error" | "stopped";

/**
 * Maps a service state to its tone (port conflicts are errors).
 *
 * @param state - Service state.
 * @returns The tone.
 */
export function toneOf(state: ServiceState): StatusTone {
	if (state === "port-conflict") return "error";
	return state;
}

/** Badge label per state (design brief). */
export const STATE_LABEL: Readonly<Record<ServiceState, string>> = {
	running: "Running",
	starting: "Starting…",
	stopped: "Stopped",
	"port-conflict": "Port conflict",
	error: "Error",
};

const DOT: Readonly<Record<StatusTone, string>> = {
	running: "bg-status-running shadow-[0_0_0_3px_rgba(22,163,74,.18)]",
	starting: "bg-status-starting shadow-[0_0_0_3px_rgba(245,158,11,.2)]",
	error: "bg-status-error shadow-[0_0_0_3px_rgba(220,38,38,.18)]",
	stopped: "border-[1.5px] border-status-stopped",
};

/** Props of {@link StatusDot}. */
export interface StatusDotProps {
	readonly tone: StatusTone;
	readonly className?: string;
}

/** 8px status dot with a soft halo (hollow when stopped). */
export function StatusDot({ tone, className }: StatusDotProps) {
	return (
		<span
			aria-hidden
			data-tone={tone}
			className={cn(
				"inline-block size-2 flex-none rounded-full",
				DOT[tone],
				className,
			)}
		/>
	);
}

/** Props of {@link StatusPill}. */
export interface StatusPillProps {
	readonly tone: StatusTone;
	readonly label: string;
}

/** Neutral bordered pill with a status dot (cards, detail header). */
export function StatusPill({ tone, label }: StatusPillProps) {
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border py-px pr-[9px] pl-[7px] text-[12px]">
			<StatusDot tone={tone} />
			{label}
		</span>
	);
}

const BADGE: Readonly<Record<StatusTone, string>> = {
	running:
		"border-status-running-border bg-status-running-bg text-status-running-fg",
	starting:
		"border-status-starting-border bg-status-starting-bg text-status-starting-fg",
	error: "border-status-error-border bg-status-error-bg text-status-error-fg",
	stopped:
		"border-status-stopped-border bg-status-stopped-bg text-status-stopped-fg",
};

const BADGE_DOT: Readonly<Record<StatusTone, string>> = {
	running: "bg-status-running",
	starting: "bg-status-starting",
	error: "bg-status-error",
	stopped: "bg-status-stopped",
};

/** Props of {@link StatusBadge}. */
export interface StatusBadgeProps {
	readonly state: ServiceState;
}

/** Tinted status badge of the overview table. */
export function StatusBadge({ state }: StatusBadgeProps) {
	const tone = toneOf(state);
	return (
		<span
			className={cn(
				"inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 font-medium text-[12px]",
				BADGE[tone],
			)}
		>
			<span
				aria-hidden
				className={cn("size-1.5 rounded-full", BADGE_DOT[tone])}
			/>
			{STATE_LABEL[state]}
		</span>
	);
}
