import { api, unwrap } from "@/shared/lib/api";
import { useObserverStore } from "@/shared/lib/observer/observer-store";

const service = (project: string, name: string) =>
	api.api.projects({ project }).services({ name });

/**
 * One-shot log history over REST (`GET …/logs?tail=`), no WebSocket. The
 * container's buffer is replaced by the returned lines, so the Logs tab
 * renders them exactly like a streamed batch.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param containerId - Container id (key of the log buffer).
 * @param tail - Lines of history.
 * @returns Resolves once the lines are in the store.
 * @throws ApiRequestError when the request fails.
 */
export async function fetchLogTail(
	project: string,
	name: string,
	containerId: string,
	tail: number,
): Promise<void> {
	const { lines } = await unwrap(
		service(project, name).logs.get({ query: { tail } }),
	);
	const store = useObserverStore.getState();
	store.clearLogs(containerId);
	store.apply({
		channel: `logs:${containerId}`,
		type: "log",
		payload: { lines },
	});
}

/**
 * One-shot CPU/memory reading over REST (`GET …/stats`), no WebSocket. The
 * sample is appended to the container's stats history, where the Metrics
 * tab reads its "last known" numbers.
 *
 * @param project - Project name.
 * @param name - Service instance name.
 * @param containerId - Container id (key of the stats history).
 * @returns Resolves once the reading is in the store.
 * @throws ApiRequestError when the request fails.
 */
export async function fetchStatsOnce(
	project: string,
	name: string,
	containerId: string,
): Promise<void> {
	const { samples } = await unwrap(service(project, name).stats.get());
	if (samples.length === 0) return;
	useObserverStore.getState().apply({
		channel: `stats:${containerId}`,
		type: "stats",
		payload: { samples },
	});
}
