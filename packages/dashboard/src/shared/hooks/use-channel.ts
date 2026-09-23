import { useEffect } from "react";
import { subscribeChannel } from "@/shared/lib/observer/observer";

/**
 * Keeps an observer channel subscribed while the component is mounted.
 *
 * @param channel - Channel name, or `null` to subscribe to nothing.
 * @param tail - Log history lines (logs channels).
 */
export function useChannel(channel: string | null, tail?: number): void {
	useEffect(() => {
		if (!channel) return;
		return subscribeChannel(channel, tail);
	}, [channel, tail]);
}
