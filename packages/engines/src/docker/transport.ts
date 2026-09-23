/** Request options accepted by {@link DockerTransport.request}. */
export interface DockerRequestInit {
	/** HTTP method (default `GET`). */
	readonly method?: string;
	/** Extra request headers. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Request body (JSON callers stringify first). */
	readonly body?: string;
	/** Aborts the request (and any streaming body). */
	readonly signal?: AbortSignal;
}

/**
 * Carries HTTP requests to the Docker Engine API.
 *
 * Implementations (unix socket, Windows named pipe, test fakes) are interchangeable:
 * callers pass an unversioned API path and get back a standard `Response`.
 */
export interface DockerTransport {
	/**
	 * Sends a request to the Engine API.
	 *
	 * @param path - Unversioned API path including query, e.g. `/containers/json?all=1`.
	 * @param init - Method, headers, body and abort signal.
	 * @returns The raw HTTP response (non-2xx responses resolve, they do not reject).
	 * @throws {OpError} `DOCKER_UNREACHABLE` when the daemon cannot be reached.
	 */
	request(path: string, init?: DockerRequestInit): Promise<Response>;
}
