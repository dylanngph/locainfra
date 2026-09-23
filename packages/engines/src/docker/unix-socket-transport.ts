import { OpError, type SocketLocator } from "@locainfra/core";
import {
	negotiateApiVersion,
	PREFERRED_DOCKER_API_VERSION,
} from "./api-version";
import type { DockerRequestInit, DockerTransport } from "./transport";

/** `fetch` signature used by {@link UnixSocketTransport} (Bun's `fetch` with the `unix` option). */
export type UnixFetch = (
	url: string,
	init: BunFetchRequestInit,
) => Promise<Response>;

/** Options for {@link UnixSocketTransport}. Provide `socketPath` or `locator`. */
export interface UnixSocketTransportOptions {
	/** Fixed socket path. Takes precedence over `locator`. */
	readonly socketPath?: string;
	/** Lazily discovers the socket on first request. */
	readonly locator?: SocketLocator;
	/** API version to request (default {@link PREFERRED_DOCKER_API_VERSION}); lowered to the daemon's when older. */
	readonly apiVersion?: string;
	/** `fetch` implementation (default global Bun `fetch`). */
	readonly fetch?: UnixFetch;
}

/** Base URL for unix-socket HTTP; the host part is ignored by the daemon. */
const BASE_URL = "http://localhost";

/**
 * {@link DockerTransport} over a unix socket using Bun's `fetch(url, { unix })`.
 *
 * Paths are prefixed with `/v<version>`; the version is negotiated once via the
 * unversioned `GET /version` (use the daemon's `ApiVersion` when it is older than preferred).
 */
export class UnixSocketTransport implements DockerTransport {
	readonly #options: UnixSocketTransportOptions;
	readonly #fetch: UnixFetch;
	#socket: Promise<string> | undefined;
	#version: Promise<string> | undefined;

	/** @param options - Socket source, API version and fetch override. */
	constructor(options: UnixSocketTransportOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
	}

	/**
	 * @returns The negotiated Engine API version (e.g. `1.44`).
	 * @throws {OpError} `DOCKER_UNREACHABLE` when no socket is found.
	 */
	apiVersion(): Promise<string> {
		this.#version ??= this.#negotiate().catch((error: unknown) => {
			this.#version = undefined;
			throw error;
		});
		return this.#version;
	}

	/**
	 * @param path - Unversioned API path including query.
	 * @param init - Method, headers, body and abort signal.
	 * @returns The raw HTTP response.
	 * @throws {OpError} `DOCKER_UNREACHABLE` when the socket is missing or refuses connections.
	 */
	async request(path: string, init: DockerRequestInit = {}): Promise<Response> {
		const version = await this.apiVersion();
		const socket = await this.socketPath();
		return this.#send(socket, `/v${version}${path}`, init);
	}

	/**
	 * Resolves (once) the socket the daemon listens on. Used by
	 * `UnixSocketHijacker`, which needs a raw connection for `docker exec -i`.
	 *
	 * @returns Absolute socket path.
	 * @throws {OpError} `DOCKER_UNREACHABLE` when no socket is found.
	 */
	socketPath(): Promise<string> {
		this.#socket ??= this.#locate().catch((error: unknown) => {
			this.#socket = undefined;
			throw error;
		});
		return this.#socket;
	}

	async #locate(): Promise<string> {
		const found =
			this.#options.socketPath ??
			(await this.#options.locator?.locate()) ??
			null;
		if (found === null) {
			throw new OpError(
				"DOCKER_UNREACHABLE",
				"Docker socket not found. Is Docker running?",
			);
		}
		return found;
	}

	async #negotiate(): Promise<string> {
		const preferred = this.#options.apiVersion ?? PREFERRED_DOCKER_API_VERSION;
		const socket = await this.socketPath();
		const response = await this.#send(socket, "/version", {});
		if (!response.ok) {
			await response.body?.cancel();
			return preferred;
		}
		const body: unknown = await response.json().catch(() => undefined);
		const daemon =
			typeof body === "object" &&
			body !== null &&
			"ApiVersion" in body &&
			typeof body.ApiVersion === "string"
				? body.ApiVersion
				: undefined;
		return negotiateApiVersion(preferred, daemon);
	}

	async #send(
		socket: string,
		path: string,
		init: DockerRequestInit,
	): Promise<Response> {
		try {
			return await this.#fetch(`${BASE_URL}${path}`, {
				method: init.method ?? "GET",
				headers: init.headers ? { ...init.headers } : undefined,
				body: init.body,
				signal: init.signal,
				unix: socket,
			});
		} catch (cause) {
			if (init.signal?.aborted) throw cause;
			throw new OpError(
				"DOCKER_UNREACHABLE",
				`Cannot reach the Docker daemon at ${socket}`,
				{ details: { socket }, cause },
			);
		}
	}
}
