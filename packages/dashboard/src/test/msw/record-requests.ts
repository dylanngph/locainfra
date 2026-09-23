import { afterEach } from "vitest";
import { server } from "./node";

/** One recorded request: path and parsed JSON body (`undefined` when empty). */
export interface RecordedRequest {
	readonly url: string;
	body: unknown;
}

afterEach(() => server.events.removeAllListeners("request:start"));

/**
 * Records requests matching a method and path while the mock backend keeps
 * answering them (no handler override). Listeners are removed after each test.
 *
 * @param method - HTTP method, e.g. `POST`.
 * @param path - Pattern tested against the URL path.
 * @returns The live list of recorded requests.
 */
export function recordRequests(
	method: string,
	path: RegExp,
): RecordedRequest[] {
	const calls: RecordedRequest[] = [];
	server.events.on("request:start", ({ request }) => {
		const url = new URL(request.url).pathname;
		if (request.method !== method || !path.test(url)) return;
		const call: RecordedRequest = { url, body: undefined };
		calls.push(call);
		void request
			.clone()
			.text()
			.then((text) => {
				call.body = text ? JSON.parse(text) : undefined;
			});
	});
	return calls;
}
