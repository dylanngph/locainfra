import {
	type ContainerFilter,
	type ContainerReader,
	type ContainerSummary,
	type DockerInfo,
	type DockerInfoPort,
	OpError,
} from "@locainfra/core";
import {
	buildContainerListQuery,
	toContainerSummary,
	toDockerInfo,
} from "./container-mapper";
import type { DockerTransport } from "./transport";

/**
 * Read-only Engine API client: implements {@link DockerInfoPort} and {@link ContainerReader}.
 * Lifecycle writes go through the compose runner, never through this client.
 */
export class DockerClient implements DockerInfoPort, ContainerReader {
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

	async #getJson(path: string): Promise<unknown> {
		const response = await this.#transport.request(path);
		if (!response.ok) {
			const message = await readDockerErrorMessage(response);
			throw new OpError(
				"UNKNOWN",
				`Docker API ${path.split("?")[0]} failed with ${response.status}: ${message}`,
				{ details: { status: response.status } },
			);
		}
		try {
			return await response.json();
		} catch (cause) {
			throw new OpError("UNKNOWN", "Docker API returned invalid JSON", {
				cause,
			});
		}
	}
}

async function readDockerErrorMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"message" in parsed &&
			typeof parsed.message === "string"
		) {
			return parsed.message;
		}
	} catch {
		// Not JSON: fall through to the raw text.
	}
	return text.slice(0, 200) || response.statusText;
}
