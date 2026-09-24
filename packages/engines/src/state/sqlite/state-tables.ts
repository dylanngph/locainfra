import type {
	ProjectEntry,
	RegistryState,
	StackState,
	StateFile,
} from "@locastack/core";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";
import { portPins, projects, registry, stacks } from "./schema";

/**
 * A synchronous Drizzle handle over the state schema (`bun:sqlite`): the
 * database itself or a transaction on it.
 */
export type StateTx = BaseSQLiteDatabase<"sync", void, typeof schema>;

/** Options for {@link writeState}. */
export interface WriteStateOptions {
	/** ISO-8601 time stamped on newly registered projects. */
	readonly now: string;
	/**
	 * Skip pins whose port is already taken instead of failing (used when
	 * importing a hand-edited `state.json`). Default `false`.
	 */
	readonly skipConflictingPins?: boolean;
}

/**
 * Reads the whole {@link StateFile} inside `tx`.
 *
 * @param tx - Transaction (a read snapshot).
 * @returns Projects in registration order, stacks with their pins, registry.
 */
export function readState(tx: StateTx): StateFile {
	const projectRows = tx.select().from(projects).orderBy(asc(sql`rowid`)).all();
	const stackRows = tx.select().from(stacks).orderBy(asc(sql`rowid`)).all();
	const pinRows = tx.select().from(portPins).orderBy(asc(sql`rowid`)).all();
	const registryRow = tx
		.select()
		.from(registry)
		.where(eq(registry.id, 1))
		.get();

	const stackState: Record<string, StackState> = {};
	for (const row of stackRows) {
		stackState[row.name] = { ports: {}, createdAt: row.createdAt };
	}
	for (const pin of pinRows) {
		const stack = stackState[pin.project];
		if (stack) stack.ports[pin.service] = pin.port;
	}
	const state: StateFile = {
		projects: projectRows.map(
			(row): ProjectEntry =>
				row.envFile === null
					? { name: row.name, root: row.root }
					: { name: row.name, root: row.root, envFile: row.envFile },
		),
		stacks: stackState,
	};
	if (registryRow) {
		const reg: RegistryState =
			registryRow.etag === null
				? { updatedAt: registryRow.updatedAt }
				: { etag: registryRow.etag, updatedAt: registryRow.updatedAt };
		state.registry = reg;
	}
	return state;
}

/**
 * Whether the database holds no projects and no stacks.
 *
 * @param tx - Transaction.
 * @returns `true` for a fresh database.
 */
export function isStateEmpty(tx: StateTx): boolean {
	const project = tx
		.select({ name: projects.name })
		.from(projects)
		.limit(1)
		.get();
	const stack = tx.select({ name: stacks.name }).from(stacks).limit(1).get();
	return project === undefined && stack === undefined;
}

function sameProjects(
	a: readonly ProjectEntry[],
	b: readonly ProjectEntry[],
): boolean {
	return (
		a.length === b.length &&
		a.every((p, i) => {
			const q = b[i];
			return (
				q !== undefined &&
				p.name === q.name &&
				p.root === q.root &&
				p.envFile === q.envFile
			);
		})
	);
}

function samePorts(
	a: Readonly<Record<string, number>>,
	b: Readonly<Record<string, number>>,
): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => a[key] === b[key])
	);
}

function writeProjects(
	tx: StateTx,
	current: readonly ProjectEntry[],
	next: readonly ProjectEntry[],
	now: string,
): void {
	if (sameProjects(current, next)) return;
	const createdAt = new Map(
		tx
			.select({ name: projects.name, createdAt: projects.createdAt })
			.from(projects)
			.all()
			.map((row) => [row.name, row.createdAt]),
	);
	// Rewrite so rowid order matches the array order.
	tx.delete(projects).run();
	if (next.length === 0) return;
	tx.insert(projects)
		.values(
			next.map((p) => ({
				name: p.name,
				root: p.root,
				envFile: p.envFile ?? null,
				createdAt: createdAt.get(p.name) ?? now,
			})),
		)
		.run();
}

function writeStacks(
	tx: StateTx,
	current: StateFile["stacks"],
	next: StateFile["stacks"],
	skipConflictingPins: boolean,
): void {
	const removed = Object.keys(current).filter((name) => !(name in next));
	const repinned = Object.entries(next)
		.filter(([name, stack]) => {
			const before = current[name];
			return before === undefined || !samePorts(before.ports, stack.ports);
		})
		.map(([name]) => name);

	// Deletes first, so a port moving between stacks in one mutation is legal.
	if (removed.length > 0) {
		tx.delete(stacks).where(inArray(stacks.name, removed)).run();
	}
	const existingRepinned = repinned.filter((name) => name in current);
	if (existingRepinned.length > 0) {
		tx.delete(portPins)
			.where(inArray(portPins.project, existingRepinned))
			.run();
	}

	for (const [name, stack] of Object.entries(next)) {
		const before = current[name];
		if (before === undefined) {
			tx.insert(stacks).values({ name, createdAt: stack.createdAt }).run();
		} else if (before.createdAt !== stack.createdAt) {
			tx.update(stacks)
				.set({ createdAt: stack.createdAt })
				.where(eq(stacks.name, name))
				.run();
		}
	}

	const pins = repinned.flatMap((name) =>
		Object.entries(next[name]?.ports ?? {}).map(([service, port]) => ({
			project: name,
			service,
			port,
		})),
	);
	if (pins.length === 0) return;
	const insert = tx.insert(portPins).values(pins);
	if (skipConflictingPins) insert.onConflictDoNothing().run();
	else insert.run();
}

function writeRegistry(
	tx: StateTx,
	current: RegistryState | undefined,
	next: RegistryState | undefined,
): void {
	if (next === undefined) {
		if (current !== undefined) tx.delete(registry).run();
		return;
	}
	if (current?.etag === next.etag && current?.updatedAt === next.updatedAt) {
		return;
	}
	const row = { etag: next.etag ?? null, updatedAt: next.updatedAt };
	tx.insert(registry)
		.values({ id: 1, ...row })
		.onConflictDoUpdate({ target: registry.id, set: row })
		.run();
}

/**
 * Persists `next` inside `tx`, touching only what changed relative to
 * `current` (which must be what {@link readState} returned in the same
 * transaction).
 *
 * @param tx - Write transaction (`BEGIN IMMEDIATE`).
 * @param current - State read in this transaction.
 * @param next - Validated state to persist.
 * @param options - Clock value and import leniency.
 * @throws The SQLite constraint error when two services pin one port.
 */
export function writeState(
	tx: StateTx,
	current: StateFile,
	next: StateFile,
	options: WriteStateOptions,
): void {
	writeProjects(tx, current.projects, next.projects, options.now);
	writeStacks(
		tx,
		current.stacks,
		next.stacks,
		options.skipConflictingPins ?? false,
	);
	writeRegistry(tx, current.registry, next.registry);
}
