import { type Static, Type } from "@sinclair/typebox";

/** File name of a project stack inside its project folder. */
export const PROJECT_STACK_FILE_NAME = "locastack.yaml";

/**
 * Pattern of project names and service instance names: lowercase letters,
 * digits and dashes, starting with a letter (e.g. `shop-api`, `main-db`).
 */
export const NAME_PATTERN = "^[a-z][a-z0-9-]*$";

/** Pattern of catalog definition ids referenced by `type`. */
const CATALOG_ID_PATTERN = "^[a-z0-9][a-z0-9-]*$";

/** Whether a service keeps its data in named volumes or discards it on removal. */
export const PersistMode = Type.Union(
	[Type.Literal("volume"), Type.Literal("ephemeral")],
	{
		description:
			"volume: named Docker volumes ls-<project>-<service>-<vol> survive restarts and `down`; ephemeral: no named volumes, data is lost when the container is removed",
	},
);
/** Whether a service keeps its data in named volumes (`volume`, the default) or not. */
export type PersistMode = Static<typeof PersistMode>;

/**
 * Pattern of a stack entry's `seed` path: relative to the project root, no
 * leading `/`, `\\` or `~`, no drive letter, no `..` segment, no NUL.
 */
export const SEED_PATH_PATTERN =
	"^(?![/\\\\~])(?![A-Za-z]:)(?!(?:.*[/\\\\])?\\.\\.(?:[/\\\\]|$))[^\\u0000]+$";

/** A seed file path relative to the project root (see {@link SEED_PATH_PATTERN}). */
export const SeedPath = Type.String({
	minLength: 1,
	maxLength: 1024,
	pattern: SEED_PATH_PATTERN,
	description:
		"Seed file relative to the project root, e.g. db/seed.sql; bind-mounted read-only where the catalog's seed.mountPath says. Absolute paths and .. escapes are rejected",
});
/** A seed file path relative to the project root. */
export type SeedPath = Static<typeof SeedPath>;

/** {@link PersistMode} applied when a stack entry omits `persist`. */
export const DEFAULT_PERSIST_MODE: PersistMode = "volume";

/**
 * One named service instance in a stack file. Omitted fields fall back to
 * catalog defaults (`version` → `defaultVersion`, `port` → `auto`,
 * `persist` → `volume`, `config.*` → the definition's config defaults).
 */
export const StackServiceEntry = Type.Object({
	type: Type.String({
		pattern: CATALOG_ID_PATTERN,
		description: "Catalog definition id, e.g. postgres",
	}),
	version: Type.Optional(
		Type.String({ description: "One of the definition's versions" }),
	),
	port: Type.Optional(
		Type.Union(
			[Type.Integer({ minimum: 1, maximum: 65535 }), Type.Literal("auto")],
			{
				description:
					"Host port bound on 127.0.0.1; auto (the default) allocates and pins a free one",
			},
		),
	),
	persist: Type.Optional(PersistMode),
	config: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Overrides of the definition's config values",
		}),
	),
	seed: Type.Optional(SeedPath),
	uses: Type.Optional(
		Type.Record(Type.String({ pattern: CATALOG_ID_PATTERN }), Type.String(), {
			description:
				"Catalog id → instance name satisfying the definition's dependsOn; only needed when the stack holds several instances of that type",
		}),
	),
});
/** One named service instance in a stack file. */
export type StackServiceEntry = Static<typeof StackServiceEntry>;

/** Optional env-file linking settings of a project stack. */
export const StackLink = Type.Object({
	file: Type.Optional(
		Type.String({
			description: "Env file relative to the project root, e.g. .env.local",
		}),
	),
	names: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Service instance name → variable name for its primary URL",
		}),
	),
});
/** Env-file linking settings. */
export type StackLink = Static<typeof StackLink>;

/**
 * Schema of `locastack.yaml`. Secrets never appear here.
 * `services` keys are instance names; several instances may share a `type`.
 */
export const StackFile = Type.Object(
	{
		version: Type.Literal(1),
		name: Type.String({
			pattern: NAME_PATTERN,
			description: "Project name; compose project and network become ls-<name>",
		}),
		services: Type.Record(
			Type.String({ pattern: NAME_PATTERN }),
			StackServiceEntry,
			{
				default: {},
				additionalProperties: false,
			},
		),
		link: Type.Optional(StackLink),
	},
	{ $id: "https://locastack.dev/schema/v1.json" },
);
/** Parsed stack file. */
export type StackFile = Static<typeof StackFile>;

/** A validated project stack: a folder containing `locastack.yaml`. */
export const Stack = Type.Object({
	name: Type.String({ description: "Project name (= file.name)" }),
	root: Type.String({ description: "Absolute path of the project folder" }),
	filePath: Type.String({
		description: "Absolute path of <root>/locastack.yaml",
	}),
	file: StackFile,
});
/** A validated project stack. */
export type Stack = Static<typeof Stack>;

/** Construction options for {@link StackError}. */
export interface StackErrorOptions {
	/** Stack file path, when known. */
	readonly filePath?: string;
	/** Individual validation messages. */
	readonly issues?: readonly string[];
	/** Underlying error. */
	readonly cause?: unknown;
}

/** A stack file could not be found, parsed, or validated. */
export class StackError extends Error {
	/** Stack file path, when known. */
	readonly filePath: string | undefined;
	/** Individual validation messages. */
	readonly issues: readonly string[];

	/**
	 * @param message - Human-readable summary.
	 * @param options - Path, issues and cause.
	 */
	constructor(message: string, options: StackErrorOptions = {}) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "StackError";
		this.filePath = options.filePath;
		this.issues = options.issues ?? [];
	}
}
