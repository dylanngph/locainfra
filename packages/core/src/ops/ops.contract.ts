import type { CatalogSource } from "../catalog/catalog.source";
import type { EnvFormat } from "../env/formats/env-formatter";
import type { ComposeInfoPort, LifecycleRunner } from "../ports/compose.port";
import type { DockerInfoPort, SocketLocator } from "../ports/docker.port";
import type {
	Clock,
	FileStore,
	PortProbe,
	SecretGenerator,
} from "../ports/files.port";
import type { Paths } from "../ports/paths.port";
import type { SecretStore } from "../ports/secrets.port";
import type { StateReader, StateWriter } from "../ports/state.port";
import type { OpError } from "../shared/op-error";
import type { Progress } from "../shared/progress.model";
import type { Result } from "../shared/result";
import type { Stack } from "../stack/stack.model";
import type { DoctorReport } from "./doctor/doctor.model";

/** Ports required by {@link RunDoctor}. */
export interface RunDoctorDeps {
	/** Engine API daemon info. */
	readonly docker: DockerInfoPort;
	/** Compose plugin version. */
	readonly compose: ComposeInfoPort;
	/** Docker socket discovery. */
	readonly socket: SocketLocator;
	/** Time source for `generatedAt`. */
	readonly clock: Clock;
}

/** Diagnoses Docker, compose version and socket. Never throws; failures become `fail` checks. */
export type RunDoctor = (deps: RunDoctorDeps) => Promise<DoctorReport>;

/** Ports required by {@link UpStack}. */
export interface UpStackDeps {
	/** File access. */
	readonly files: FileStore;
	/** Persisted state (ports pinned here). */
	readonly state: StateReader & StateWriter;
	/** Secret persistence. */
	readonly secrets: SecretStore;
	/** Host port probe. */
	readonly probe: PortProbe;
	/** Secret generator. */
	readonly gen: SecretGenerator;
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Compose plugin version (checked against `MIN_COMPOSE_VERSION` before `up`). */
	readonly compose: ComposeInfoPort;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Time source. */
	readonly clock: Clock;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
}

/** Input of {@link UpStack}. */
export interface UpStackInput {
	/** Stack to start. */
	readonly stack: Stack;
	/** Limit to these service ids (all when omitted). */
	readonly services?: readonly string[];
}

/**
 * Checks the compose version, claims the stack name for its project folder,
 * then resolves, renders and `compose up --wait`s the stack, streaming
 * progress. Ends with exactly one `done` or `error` event.
 */
export type UpStack = (
	deps: UpStackDeps,
	input: UpStackInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link DownStack}. */
export interface DownStackDeps {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Persisted state (project registry: which folder owns the stack name). */
	readonly state: StateReader;
	/** File access (detects a stale project registration). */
	readonly files: FileStore;
}

/** Input of {@link DownStack}. */
export interface DownStackInput {
	/** Stack to stop. */
	readonly stack: Stack;
	/** Also remove named volumes (destructive; callers confirm first). */
	readonly volumes?: boolean;
}

/**
 * Stops a stack's compose project, streaming progress. Refuses (one `error`
 * event) a project stack whose name belongs to another project folder.
 */
export type DownStack = (
	deps: DownStackDeps,
	input: DownStackInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link EnvForStack}. */
export interface EnvForStackDeps {
	/** File access. */
	readonly files: FileStore;
	/** Persisted state (pinned ports). */
	readonly state: StateReader;
	/** Secret persistence. */
	readonly secrets: SecretStore;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
}

/** Input of {@link EnvForStack}. */
export interface EnvForStackInput {
	/** Stack whose exports to print. */
	readonly stack: Stack;
	/** Output format. */
	readonly format: EnvFormat;
}

/**
 * Renders a stack's exported connection variables in the requested format.
 * Refuses a project stack whose name belongs to another project folder.
 */
export type EnvForStack = (
	deps: EnvForStackDeps,
	input: EnvForStackInput,
) => Promise<Result<string, OpError>>;

/** Ports required by {@link DiscoverStack}. */
export interface DiscoverStackDeps {
	/** File access. */
	readonly files: FileStore;
	/** Filesystem layout. */
	readonly paths: Paths;
}

/** Input of {@link DiscoverStack}. */
export interface DiscoverStackInput {
	/** Directory to start the walk-up from. */
	readonly cwd: string;
	/** Load `~/.locainfra/global.yaml` instead of walking up. */
	readonly global?: boolean;
}

/** Finds and validates the stack for `cwd` (walk-up to `locainfra.yaml`) or the global stack. */
export type DiscoverStack = (
	deps: DiscoverStackDeps,
	input: DiscoverStackInput,
) => Promise<Result<Stack, OpError>>;
