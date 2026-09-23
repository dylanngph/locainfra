import { type Static, Type } from "@sinclair/typebox";

const ID_PATTERN = "^[a-z0-9][a-z0-9-]*$";
const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const DURATION_PATTERN = "^([0-9]+(ns|us|ms|s|m|h))+$";

const Port = Type.Integer({ minimum: 1, maximum: 65535 });
const EnvName = Type.String({ pattern: ENV_NAME_PATTERN });
const Duration = Type.String({
	pattern: DURATION_PATTERN,
	description: "Compose duration, e.g. 5s or 1m30s",
});

/** Catalog category shown in the Services Explorer. */
export const ServiceCategory = Type.Union([
	Type.Literal("database"),
	Type.Literal("cache"),
	Type.Literal("queue"),
	Type.Literal("storage"),
	Type.Literal("mail"),
	Type.Literal("search"),
	Type.Literal("auth"),
	Type.Literal("observability"),
	Type.Literal("other"),
]);
/** Catalog category. */
export type ServiceCategory = Static<typeof ServiceCategory>;

/** Built-in dashboard panel a service opts into; remote UI code is never loaded. */
export const StudioPanel = Type.Union([
	Type.Literal("sql"),
	Type.Literal("redis"),
	Type.Literal("iframe"),
	Type.Literal("link"),
	Type.Literal("none"),
]);
/** Built-in dashboard panel kind. */
export type StudioPanel = Static<typeof StudioPanel>;

/** Container and host port policy of a service. */
export const ServicePort = Type.Object({
	container: Port,
	default: Type.Integer({
		minimum: 1,
		maximum: 65535,
		description: "Canonical host port (used by the global stack)",
	}),
	range: Type.Tuple([Port, Port], {
		description: "Inclusive host port range for auto allocation",
	}),
});
/** Container and host port policy. */
export type ServicePort = Static<typeof ServicePort>;

/** A user-tunable config value with its default (may be a template). */
export const ConfigValue = Type.Object({
	default: Type.String(),
	description: Type.Optional(Type.String()),
	pattern: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Regular expression the effective value must match (anchor it with ^…$). Use it for values interpolated into commands or URLs.",
		}),
	),
});
/** A user-tunable config value. */
export type ConfigValue = Static<typeof ConfigValue>;

/** A named volume mounted into the service container. */
export const ServiceVolume = Type.Object({
	name: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" }),
	path: Type.String({
		pattern: "^/",
		description: "Absolute path inside the container",
	}),
});
/** A named volume mount. */
export type ServiceVolume = Static<typeof ServiceVolume>;

/** Container healthcheck (compose semantics). */
export const ServiceHealthcheck = Type.Object({
	test: Type.Array(Type.String(), {
		minItems: 1,
		description: 'e.g. ["CMD-SHELL", "pg_isready"]; items may be templates',
	}),
	interval: Type.Optional(Duration),
	retries: Type.Optional(Type.Integer({ minimum: 0 })),
	timeout: Type.Optional(Duration),
	startPeriod: Type.Optional(Duration),
});
/** Container healthcheck. */
export type ServiceHealthcheck = Static<typeof ServiceHealthcheck>;

/** Optional dashboard data panel for the service. */
export const ServiceStudio = Type.Object({
	panel: StudioPanel,
	url: Type.Optional(
		Type.String({ description: "Template URL for iframe/link panels" }),
	),
});
/** Optional dashboard data panel. */
export type ServiceStudio = Static<typeof ServiceStudio>;

/**
 * A data-only catalog service definition (`catalog/*.yaml`, registry, overrides).
 *
 * String values may contain `{{path}}` templates over
 * `{ version, port, stack, config, secrets, services.<id>.* }`.
 * Parse with `Value.Parse(ServiceDefinition, raw)` so collection defaults and
 * scalar conversion (e.g. YAML `17` → `"17"`) apply.
 */
export const ServiceDefinition = Type.Object(
	{
		id: Type.String({ pattern: ID_PATTERN }),
		name: Type.String({ minLength: 1 }),
		description: Type.Optional(Type.String()),
		category: ServiceCategory,
		tags: Type.Array(Type.String(), { default: [] }),
		icon: Type.Optional(Type.String()),
		iconUrl: Type.Optional(Type.String()),
		homepage: Type.Optional(Type.String()),
		image: Type.String({
			minLength: 1,
			description: "Image reference template, e.g. postgres:{{version}}-alpine",
		}),
		versions: Type.Array(Type.String(), { minItems: 1 }),
		defaultVersion: Type.String(),
		port: ServicePort,
		secrets: Type.Array(EnvName, { default: [] }),
		config: Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			ConfigValue,
			{
				default: {},
				additionalProperties: false,
			},
		),
		env: Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			Type.String(),
			{
				default: {},
				additionalProperties: false,
			},
		),
		volumes: Type.Array(ServiceVolume, { default: [] }),
		command: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				description:
					"Container command override (compose `command`, exec form); items may be templates, e.g. [redis-server, --requirepass, '{{secrets.REDIS_PASSWORD}}']",
			}),
		),
		healthcheck: ServiceHealthcheck,
		exports: Type.Record(
			Type.String({ pattern: ENV_NAME_PATTERN }),
			Type.String(),
			{
				default: {},
				additionalProperties: false,
			},
		),
		connect: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
		dependsOn: Type.Optional(Type.Array(Type.String({ pattern: ID_PATTERN }))),
		studio: Type.Optional(ServiceStudio),
	},
	{ $id: "https://locainfra.dev/schema/service.v1.json" },
);
/** A data-only catalog service definition. */
export type ServiceDefinition = Static<typeof ServiceDefinition>;

/** Construction options for {@link CatalogError}. */
export interface CatalogErrorOptions {
	/** Definition id, when known. */
	readonly catalogId?: string;
	/** Origin of the definition (file path or URL). */
	readonly source?: string;
	/** Individual validation messages. */
	readonly issues?: readonly string[];
	/** Underlying error. */
	readonly cause?: unknown;
}

/** A catalog definition failed to load, parse, or validate. */
export class CatalogError extends Error {
	/** Definition id, when known. */
	readonly catalogId: string | undefined;
	/** Origin of the definition (file path or URL). */
	readonly source: string | undefined;
	/** Individual validation messages. */
	readonly issues: readonly string[];

	/**
	 * @param message - Human-readable summary.
	 * @param options - Id, source, issues and cause.
	 */
	constructor(message: string, options: CatalogErrorOptions = {}) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "CatalogError";
		this.catalogId = options.catalogId;
		this.source = options.source;
		this.issues = options.issues ?? [];
	}
}
