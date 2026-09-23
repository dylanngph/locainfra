import { useId } from "react";
import { useLiveMode, useLiveModeStore } from "@/shared/lib/live/live-mode";
import { cn } from "@/shared/lib/utils";
import { Switch } from "@/shared/ui/switch";

/** Props of {@link LiveSwitch}. */
export interface LiveSwitchProps {
	readonly project: string;
}

/**
 * Project bar "Live" switch (off on every fresh load; kept in memory per project). On:
 * the observer WebSocket streams status and metrics for this project only.
 * A pulsing green dot shows while it is on.
 */
export function LiveSwitch({ project }: LiveSwitchProps) {
	const live = useLiveMode(project);
	const setLive = useLiveModeStore((s) => s.setLive);
	const labelId = useId();
	return (
		<div
			className="flex items-center gap-2 text-[12.5px]"
			title={
				live
					? "Streaming status and metrics for this project"
					: "Turn on to stream status, metrics and logs"
			}
		>
			<span aria-hidden className="relative flex size-2">
				{live ? (
					<span
						data-testid="live-pulse"
						className="absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-60"
					/>
				) : null}
				<span
					className={cn(
						"relative inline-flex size-2 rounded-full",
						live ? "bg-status-running" : "border-[1.5px] border-status-stopped",
					)}
				/>
			</span>
			<span
				id={labelId}
				className={cn(
					"font-medium",
					live ? "text-foreground" : "text-muted-foreground",
				)}
			>
				Live
			</span>
			<Switch
				size="sm"
				aria-labelledby={labelId}
				checked={live}
				onCheckedChange={(checked) => setLive(project, checked)}
			/>
		</div>
	);
}
