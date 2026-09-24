import { type Static, Type } from "@sinclair/typebox";

/** A project folder registered with LocaStack. */
export const ProjectEntry = Type.Object({
	name: Type.String({ description: "Stack name of the project" }),
	root: Type.String({ description: "Absolute path of the project folder" }),
	envFile: Type.Optional(
		Type.String({ description: "Env file to link, relative to root" }),
	),
});
/** A registered project folder. */
export type ProjectEntry = Static<typeof ProjectEntry>;

/** Persisted per-stack state: pinned host ports and creation time. */
export const StackState = Type.Object({
	ports: Type.Record(Type.String(), Type.Integer(), {
		description: "Service id → pinned host port",
	}),
	createdAt: Type.String({ description: "ISO-8601 timestamp" }),
});
/** Persisted per-stack state. */
export type StackState = Static<typeof StackState>;

/** Registry cache metadata. */
export const RegistryState = Type.Object({
	etag: Type.Optional(Type.String()),
	updatedAt: Type.String({ description: "ISO-8601 timestamp" }),
});
/** Registry cache metadata. */
export type RegistryState = Static<typeof RegistryState>;

/** Machine-local state (stored in `locastack.db`; also the legacy `state.json` shape). Missing collections default to empty on parse. */
export const StateFile = Type.Object({
	projects: Type.Array(ProjectEntry, { default: [] }),
	stacks: Type.Record(Type.String(), StackState, { default: {} }),
	registry: Type.Optional(RegistryState),
});
/** Machine-local state (projects, pinned ports), persisted in `~/.locastack/locastack.db`. */
export type StateFile = Static<typeof StateFile>;

/**
 * Creates an empty {@link StateFile} (what a fresh state store reads as).
 *
 * @returns A fresh, empty state object.
 */
export function createEmptyState(): StateFile {
	return { projects: [], stacks: {} };
}

/** Reads persisted state. A missing file yields {@link createEmptyState}. */
export interface StateReader {
	/** @returns The current state. */
	read(): Promise<StateFile>;
}

/** Atomically updates persisted state (one serialized transaction). */
export interface StateWriter {
	/**
	 * Applies `mutate` to the current state inside one transaction and persists the result.
	 *
	 * @param mutate - Pure function from old state to new state.
	 * @returns The state as written.
	 */
	update(mutate: (state: StateFile) => StateFile): Promise<StateFile>;
}
