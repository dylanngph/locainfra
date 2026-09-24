import type { ServiceDefinition } from "../catalog/catalog.model";
import type { PersistMode } from "../stack/stack.model";

/** A named volume of a resolved service. */
export interface ResolvedVolume {
	/**
	 * Docker volume name, `ls-<stack>-<instance>-<source>` (see
	 * `serviceVolumeName`); also the compose volume key.
	 */
	readonly name: string;
	/** Catalog volume name, e.g. `data`. */
	readonly source: string;
	/** Mount path inside the container. */
	readonly path: string;
}

/** Read-only bind mount of a stack entry's seed file (catalog `seed` block). */
export interface ResolvedSeedMount {
	/**
	 * Absolute host path, `<project root>/<entry.seed>`; canonical (symlinks
	 * resolved) once the compose writer verified it.
	 */
	readonly source: string;
	/** Absolute project folder the source must stay inside. */
	readonly root: string;
	/** Absolute container path, `<seed.mountPath>/<seed.fileName>`. */
	readonly target: string;
}

/** A container healthcheck with templates evaluated. */
export interface ResolvedHealthcheck {
	/** Test command, e.g. `["CMD-SHELL", "pg_isready -U postgres -d app"]`. */
	readonly test: readonly string[];
	/** Compose duration between checks. */
	readonly interval?: string;
	/** Compose duration before a check times out. */
	readonly timeout?: string;
	/** Consecutive failures before `unhealthy`. */
	readonly retries?: number;
	/** Compose duration of the start grace period. */
	readonly startPeriod?: string;
}

/** A fully resolved service instance: no templates, no `auto`, nothing missing. */
export interface ResolvedService {
	/** Instance name: the `services` key in `locastack.yaml`, the compose service key and its network hostname. */
	readonly name: string;
	/** Catalog definition id (`type` in the stack entry). */
	readonly type: string;
	/** Docker container name, `ls-<stack>-<name>` (see `serviceContainerName`). */
	readonly containerName: string;
	/** Data persistence (entry `persist`, default `volume`). */
	readonly persist: PersistMode;
	/** Catalog definition the service was resolved from. */
	readonly definition: ServiceDefinition;
	/** Selected version. */
	readonly version: string;
	/** Concrete image reference. */
	readonly image: string;
	/** Pinned host port (bound on 127.0.0.1). */
	readonly hostPort: number;
	/** Container port. */
	readonly containerPort: number;
	/** Effective config values. */
	readonly config: Readonly<Record<string, string>>;
	/** Secret values (never log). */
	readonly secrets: Readonly<Record<string, string>>;
	/** Container environment, templates evaluated. */
	readonly env: Readonly<Record<string, string>>;
	/** Exported connection variables, templates evaluated. */
	readonly exports: Readonly<Record<string, string>>;
	/** Named volumes; always empty when `persist` is `ephemeral`. */
	readonly volumes: readonly ResolvedVolume[];
	/** Instance names of the services this one depends on (from `dependsOn` + `uses`). */
	readonly dependsOn: readonly string[];
	/** Healthcheck, templates evaluated (always set by the resolver). */
	readonly healthcheck?: ResolvedHealthcheck;
	/** Container command override, templates evaluated (only when the definition has one). */
	readonly command?: readonly string[];
	/**
	 * Seed file mount: set when the entry has `seed` and the definition a
	 * `seed` block (an entry `seed` the definition cannot use is ignored).
	 */
	readonly seed?: ResolvedSeedMount;
}

/** A fully resolved stack, ready to render to compose. */
export interface ResolvedStack {
	/** Project name. */
	readonly name: string;
	/** Compose project name, `ls-<name>`. */
	readonly projectName: string;
	/** Compose network name, `ls-<name>`. */
	readonly network: string;
	/** Services in dependency order. */
	readonly services: readonly ResolvedService[];
}
