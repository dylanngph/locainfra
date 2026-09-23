import { type Static, Type } from "@sinclair/typebox";
import type { Progress } from "../shared/progress.model";
import { ContainerHealth } from "./docker.port";

/** Reads the installed `docker compose` plugin version. */
export interface ComposeInfoPort {
	/** @returns The short version (e.g. `5.3.0`), or `null` when compose is missing. */
	version(): Promise<string | null>;
}

/** A published port reported by `docker compose ps --format json`. */
export const ComposePublisher = Type.Object({
	publishedPort: Type.Integer(),
	targetPort: Type.Integer(),
});
/** A published port reported by compose. */
export type ComposePublisher = Static<typeof ComposePublisher>;

/** One service row of `docker compose ps`. */
export const ComposeServiceStatus = Type.Object({
	service: Type.String({ description: "Compose service key" }),
	name: Type.String({ description: "Container name" }),
	state: Type.String(),
	health: Type.Optional(ContainerHealth),
	image: Type.String(),
	publishers: Type.Array(ComposePublisher),
});
/** One service row of `docker compose ps`. */
export type ComposeServiceStatus = Static<typeof ComposeServiceStatus>;

/** Identifies a compose project on disk. */
export interface ComposeTarget {
	/** Compose project name (`li-<stack>`). */
	readonly projectName: string;
	/** Absolute path to the rendered `docker-compose.yml`. */
	readonly composeFile: string;
}

/** Input for {@link LifecycleRunner.up}. */
export interface ComposeUpInput extends ComposeTarget {
	/** Limit to these compose services (all when omitted). */
	readonly services?: readonly string[];
	/** Pass `--wait` (block until healthy). */
	readonly wait?: boolean;
	/** `--wait-timeout` in seconds. */
	readonly waitTimeoutSec?: number;
}

/** Input for {@link LifecycleRunner.down}. */
export interface ComposeDownInput extends ComposeTarget {
	/** Also remove named volumes (destructive). */
	readonly volumes?: boolean;
}

/** Input for {@link LifecycleRunner.ps}. */
export type ComposePsInput = ComposeTarget;

/** Lifecycle writes via `docker compose`. The only path that mutates containers. */
export interface LifecycleRunner {
	/**
	 * `docker compose up -d`, streaming progress. Ends with a `done` or `error` event.
	 *
	 * @param input - Project, file and options.
	 */
	up(input: ComposeUpInput): AsyncIterable<Progress>;
	/**
	 * `docker compose down`, streaming progress.
	 *
	 * @param input - Project, file and options.
	 */
	down(input: ComposeDownInput): AsyncIterable<Progress>;
	/**
	 * `docker compose ps --all --format json`.
	 *
	 * @param input - Project and file.
	 */
	ps(input: ComposePsInput): Promise<ComposeServiceStatus[]>;
}
