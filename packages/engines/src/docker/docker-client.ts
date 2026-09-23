import {
	type ContainerDetails,
	type ContainerFilter,
	type ContainerInspector,
	type ContainerReader,
	type ContainerSummary,
	type DockerInfo,
	type DockerInfoPort,
	OpError,
} from "@locainfra/core";
import {
	buildContainerListQuery,
	toContainerDetails,
	toContainerSummary,
	toDockerInfo,
} from "./container-mapper";
import { dockerApiError } from "./docker-errors";
import type { DockerTransport } from "./transport";

/**
 * Read-only Engine API client: implements {@link DockerInfoPort},
 * {@link ContainerReader} and {@link ContainerInspector}.
 * Lifecycle writes go through the compose runner, never through this client.
 */
export class DockerClient
	implements DockerInfoPort, ContainerReader, ContainerInspector
{
	readonly #transport: DockerTransport;

	/** @param transport - How requests reach the daemon. */
	constructor(transport: DockerTransport) {
		this.#transport = transport;
	}

	/**
	 * `GET /version`.
	 *
	 * @returns Daemon version and platform.
	 * @throws {OpError} `DOCKER_UNREACHABLE` when the daemon cannot be reached; `UNKNOWN` on a bad response.
	 */
	async info(): Promise<DockerInfo> {
		const body = await this.#getJson("/version");
		const info = toDockerInfo(body);
		if (info === null) {
			throw new OpError("UNKNOWN", "Unexpected /version response from Docker");
		}
		return info;
	}

	/**
	 * `GET /containers/json?all=1&filters={"label":[...]}`.
	 *
	 * @param filter - Containers must carry all these labels.
	 * @returns Running and stopped containers; malformed entries are skipped.
	 * @throws {OpError} `DOCKER_UNREACHABLE` when the daemon cannot be reached; `UNKNOWN` on a bad response.
	 */
	async list(filter: ContainerFilter): Promise<ContainerSummary[]> {
		const body = await this.#getJson(
			`/containers/json?${buildContainerListQuery(filter)}`,
		);
		if (!Array.isArray(body)) {
			throw new OpError(
				"UNKNOWN",
				"Unexpected /containers/json response from Docker",
			);
		}
		return body
			.map(toContainerSummary)
			.filter((c): c is ContainerSummary => c !== null);
	}

	/**
	 * `GET /containers/{id}/json`.
	 *
	 * @param id - Container id or name.
	 * @returns The details, or `null` when no such container exists.
	 * @throws {OpError} `DOCKER_UNREACHABLE` when the daemon cannot be reached; `UNKNOWN` on a bad response.
	 */
	async inspect(id: string): Promise<ContainerDetails | null> {
		const path = `/containers/${encodeURIComponent(id)}/json`;
		const response = await this.#transport.request(path);
		if (response.status === 404) {
			await response.body?.cancel();
			return null;
		}
		const details = toContainerDetails(await this.#parse(path, response));
		if (details === null) {
			throw new OpError(
				"UNKNOWN",
				"Unexpected /containers/{id}/json response from Docker",
			);
		}
		return details;
	}

	async #getJson(path: string): Promise<unknown> {
		return this.#parse(path, await this.#transport.request(path));
	}

	async #parse(path: string, response: Response): Promise<unknown> {
		if (!response.ok) throw await dockerApiError(response, path);
		try {
			return await response.json();
		} catch (cause) {
			throw new OpError("UNKNOWN", "Docker API returned invalid JSON", {
				cause,
			});
		}
	}
}
