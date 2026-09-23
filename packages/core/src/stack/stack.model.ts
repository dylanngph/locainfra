import { type Static, Type } from "@sinclair/typebox";

/** Name of the single global stack (`~/.locainfra/global.yaml`). */
export const GLOBAL_STACK_NAME = "global";
/** File name of a project stack inside its project folder. */
export const PROJECT_STACK_FILE_NAME = "locainfra.yaml";
/** File name of the global stack inside the state directory. */
export const GLOBAL_STACK_FILE_NAME = "global.yaml";

/** One service instance in a stack file. Omitted fields fall back to catalog defaults. */
export const StackServiceEntry = Type.Object({
	version: Type.Optional(Type.String()),
	port: Type.Optional(
		Type.Union([
			Type.Integer({ minimum: 1, maximum: 65535 }),
			Type.Literal("auto"),
		]),
	),
	config: Type.Optional(Type.Record(Type.String(), Type.String())),
});
/** One service instance in a stack file. */
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
			description: "Service id → variable name for its primary URL",
		}),
	),
});
/** Env-file linking settings. */
export type StackLink = Static<typeof StackLink>;

/**
 * Schema of `locainfra.yaml` / `global.yaml`. Secrets never appear here.
 * `services` keys are catalog ids.
 */
export const StackFile = Type.Object(
	{
		version: Type.Literal(1),
		name: Type.String({
			pattern: "^[a-z0-9][a-z0-9_-]*$",
			description: "Stack name; compose project becomes li-<name>",
		}),
		services: Type.Record(
			Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
			StackServiceEntry,
			{
				default: {},
				additionalProperties: false,
			},
		),
		link: Type.Optional(StackLink),
	},
	{ $id: "https://locainfra.dev/schema/v1.json" },
);
/** Parsed stack file. */
export type StackFile = Static<typeof StackFile>;

/** Whether a stack is the global one or belongs to a project folder. */
export const StackKind = Type.Union([
	Type.Literal("global"),
	Type.Literal("project"),
]);
/** Stack kind. */
export type StackKind = Static<typeof StackKind>;

/** A discovered, validated stack with its origin. */
export const Stack = Type.Object({
	kind: StackKind,
	name: Type.String(),
	root: Type.Optional(
		Type.String({
			description: "Project folder (absent for the global stack)",
		}),
	),
	filePath: Type.String({ description: "Absolute path of the stack file" }),
	file: StackFile,
});
/** A discovered, validated stack. */
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
