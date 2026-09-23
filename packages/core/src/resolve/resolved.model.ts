import type { ServiceDefinition } from "../catalog/catalog.model";
import type { StackKind } from "../stack/stack.model";

/** A named volume of a resolved service. */
export interface ResolvedVolume {
	/** Compose volume name (unique within the project). */
	readonly name: string;
	/** Mount path inside the container. */
	readonly path: string;
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
	/** Service key inside the stack (compose service name). */
	readonly id: string;
	/** Catalog definition id. */
	readonly catalogId: string;
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
	/** Named volumes. */
	readonly volumes: readonly ResolvedVolume[];
	/** Ids of services this one depends on. */
	readonly dependsOn: readonly string[];
	/** Healthcheck, templates evaluated (always set by the resolver). */
	readonly healthcheck?: ResolvedHealthcheck;
	/** Container command override, templates evaluated (only when the definition has one). */
	readonly command?: readonly string[];
}

/** A fully resolved stack, ready to render to compose. */
export interface ResolvedStack {
	/** Global or project. */
	readonly kind: StackKind;
	/** Stack name. */
	readonly name: string;
	/** Compose project name, `li-<name>`. */
	readonly projectName: string;
	/** Compose network name, `li-<name>`. */
	readonly network: string;
	/** Services in dependency order. */
	readonly services: readonly ResolvedService[];
}
