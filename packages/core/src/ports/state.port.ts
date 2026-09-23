import { type Static, Type } from "@sinclair/typebox";

/** A project folder registered with LocaInfra. */
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

/** Shape of `~/.locainfra/state.json`. Missing collections default to empty on parse. */
export const StateFile = Type.Object({
	projects: Type.Array(ProjectEntry, { default: [] }),
	stacks: Type.Record(Type.String(), StackState, { default: {} }),
	registry: Type.Optional(RegistryState),
});
/** Shape of `~/.locainfra/state.json`. */
export type StateFile = Static<typeof StateFile>;

/**
 * Creates an empty {@link StateFile} (what a missing `state.json` reads as).
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

/** Atomically updates persisted state (lock + temp file + rename). */
export interface StateWriter {
	/**
	 * Applies `mutate` to the current state under a lock and persists the result.
	 *
	 * @param mutate - Pure function from old state to new state.
	 * @returns The state as written.
	 */
	update(mutate: (state: StateFile) => StateFile): Promise<StateFile>;
}
