import type { Progress } from "@locainfra/server";
import type {
	InvalidateQueryFilters,
	QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { OpToast } from "@/shared/components/op-toast";
import { terminalEvent } from "./observer/observer-state";
import { useObserverStore } from "./observer/observer-store";
import { followOp } from "./observer/op-events";

/** Give up waiting for a terminal event after this long. */
export const OP_TIMEOUT_MS = 5 * 60_000;

/** Options of {@link trackOp}. */
export interface TrackOpOptions {
	/** Toast headline, e.g. "Starting main-db…". */
	readonly title: string;
	/** Client whose queries are invalidated when the op settles. */
	readonly queryClient?: QueryClient;
	/** The queries the op affects (only these are refetched). */
	readonly invalidate?: readonly InvalidateQueryFilters[];
}

/**
 * Follows a long-running action over HTTP (`GET /api/ops/:opId/events`, an
 * NDJSON stream; no WebSocket, whatever the Live mode), shows its progress
 * in a toast, invalidates the affected queries, and resolves with the
 * terminal `done`/`error` event once they have refetched. The server
 * replays buffered events, so following after the `202` is safe.
 *
 * @param opId - Operation id from the `202 { opId }` response.
 * @param options - Toast title, query client and affected queries.
 * @returns The terminal progress event.
 */
export function trackOp(
	opId: string,
	options: TrackOpOptions,
): Promise<Progress> {
	const channel = `op:${opId}`;
	const follow = new AbortController();
	void followOp(opId, follow.signal);
	const release = () => follow.abort();
	const render = () => <OpToast opId={opId} title={options.title} />;
	toast.custom(render, { id: channel, duration: Number.POSITIVE_INFINITY });

	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (event: Progress, duration: number) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			release();
			clearTimeout(timer);
			toast.custom(render, { id: channel, duration });
			const { queryClient, invalidate = [] } = options;
			void Promise.allSettled(
				queryClient
					? invalidate.map((filters) => queryClient.invalidateQueries(filters))
					: [],
			).then(() => resolve(event));
		};
		const timer = setTimeout(
			() =>
				finish(
					{ kind: "error", message: "No progress received from the server" },
					6_000,
				),
			OP_TIMEOUT_MS,
		);
		const check = () => {
			const terminal = terminalEvent(useObserverStore.getState().ops[opId]);
			if (terminal) finish(terminal, terminal.kind === "error" ? 8_000 : 3_000);
		};
		unsubscribe = useObserverStore.subscribe(check);
		check();
	});
}
