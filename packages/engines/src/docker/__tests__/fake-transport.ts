import type { DockerRequestInit, DockerTransport } from "../transport";

/** Scripted {@link DockerTransport} for tests: maps path prefixes to responses. */
export class FakeTransport implements DockerTransport {
	/** Paths requested, in order. */
	readonly calls: string[] = [];
	readonly #routes: ReadonlyArray<readonly [string, () => Response]>;

	/** @param routes - `[pathPrefix, responder]` pairs, first match wins. */
	constructor(routes: ReadonlyArray<readonly [string, () => Response]>) {
		this.#routes = routes;
	}

	/** Returns the first matching scripted response, or 404. */
	async request(path: string, _init?: DockerRequestInit): Promise<Response> {
		this.calls.push(path);
		const route = this.#routes.find(([prefix]) => path.startsWith(prefix));
		return route
			? route[1]()
			: Response.json({ message: "not found" }, { status: 404 });
	}
}
