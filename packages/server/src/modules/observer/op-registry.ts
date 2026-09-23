import {
	isOpError,
	type OpJournal,
	type Progress,
	toProgressError,
} from "@locainfra/core";

/** Tuning of {@link OpRegistry}. */
export interface OpRegistryOptions {
	/** Operations kept in memory (oldest finished ones are evicted first). Default 50. */
	readonly capacity?: number;
	/** How long a finished operation stays replayable, in ms. Default 60 000. */
	readonly retentionMs?: number;
	/** Buffered events per operation; older non-terminal events are dropped beyond it. Default 2000. */
	readonly maxEvents?: number;
	/** Millisecond clock (injectable for tests). Default `Date.now`. */
	readonly now?: () => number;
	/** Id generator (must match the `op:` channel pattern). Default `crypto.randomUUID`. */
	readonly newId?: () => string;
	/**
	 * Operation history (SQLite `ops` table). Every op with a `project` is
	 * recorded when it starts running and when it settles; journal failures
	 * never affect the op. Omitted: nothing is recorded.
	 */
	readonly journal?: OpJournal;
}

/** What to run and what it concerns. */
export interface OpStartInput {
	/** Short label, e.g. `project.up`, `service.add`. */
	readonly kind: string;
	/**
	 * Project the operation touches (status of this project is refreshed when
	 * it settles). Operations on the same project run one at a time, in start
	 * order.
	 */
	readonly project?: string;
	/** Service instance the operation touches, if any. */
	readonly service?: string;
	/**
	 * Starts the op; called once: immediately, or, when another operation on
	 * the same project is still running, as soon as the earlier ones finished.
	 */
	readonly run: () => AsyncIterable<Progress>;
}

/** Lifecycle state of a registered operation. */
export type OpState = "running" | "done" | "error";

/** Public view of a registered operation. */
export interface OpInfo {
	/** Operation id (`op:<id>` channel). */
	readonly id: string;
	/** Label given at start. */
	readonly kind: string;
	/** Project, if any. */
	readonly project?: string;
	/** Service instance, if any. */
	readonly service?: string;
	/** Current state. */
	readonly state: OpState;
	/** Buffered events so far. */
	readonly eventCount: number;
}

/** Receives an operation's progress events. */
export type OpListener = (event: Progress) => void;

/** Starts an operation in the background and returns its id. Implemented by {@link OpRegistry}. */
export interface OpLauncher {
	/**
	 * @param input - What to run.
	 * @returns The new operation id.
	 */
	start(input: OpStartInput): string;
}

/**
 * Runs short, non-streaming work in a project's operation lane (after the
 * ops queued before it, before the ones queued after). Implemented by
 * {@link OpRegistry}.
 */
export interface ProjectLane {
	/**
	 * @param project - Project whose lane to join.
	 * @param run - The work; called once the earlier ops of the project settled.
	 * @returns What `run` returns (or throws).
	 */
	exclusive<T>(project: string, run: () => Promise<T>): Promise<T>;
}

interface OpRecord {
	readonly id: string;
	readonly kind: string;
	readonly project?: string;
	readonly service?: string;
	state: OpState;
	finishedAt?: number;
	readonly events: Progress[];
	readonly listeners: Set<OpListener>;
	readonly settled: Promise<void>;
	resolveSettled: () => void;
	/** Resolves once the journal's `start` write finished (journaled ops only). */
	journaled?: Promise<void>;
}

async function safely(write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch {
		// The journal is history only: it never fails the op it records.
	}
}

const DEFAULTS = { capacity: 50, retentionMs: 60_000, maxEvents: 2000 };

/**
 * Bounded in-memory registry of long-running operations (`202 { opId }`).
 * Consumes each op's progress stream in the background, stamps every event
 * with `opId` and `at`, buffers the events and replays them to late
 * subscribers of `op:<id>`. Guarantees exactly one terminal (`done`/`error`)
 * event per operation, even when the op throws or ends without one.
 *
 * Operations on one project are serialized (a per-project promise chain):
 * every op loads `locainfra.yaml`, re-renders compose (`up` runs with
 * `--remove-orphans`) and read-modify-writes the stack file, so two ops
 * interleaving on stale snapshots could remove a sibling's new container, or
 * both conclude that neither removes the last service (leaking the project
 * network). A queued op first emits a `step` saying it waits.
 */
export class OpRegistry implements OpLauncher, ProjectLane {
	private readonly ops = new Map<string, OpRecord>();
	/** Tail of each project's op chain; removed once the chain drains. */
	private readonly lanes = new Map<string, Promise<void>>();
	private readonly settledListeners = new Set<(op: OpInfo) => void>();
	private readonly capacity: number;
	private readonly retentionMs: number;
	private readonly maxEvents: number;
	private readonly now: () => number;
	private readonly newId: () => string;
	private readonly journal: OpJournal | undefined;

	/** @param options - Capacity, retention and injectable clock/id generator. */
	constructor(options: OpRegistryOptions = {}) {
		this.capacity = options.capacity ?? DEFAULTS.capacity;
		this.retentionMs = options.retentionMs ?? DEFAULTS.retentionMs;
		this.maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? (() => crypto.randomUUID());
		this.journal = options.journal;
	}

	/** @inheritdoc */
	start(input: OpStartInput): string {
		this.prune(1);
		let resolveSettled: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const record: OpRecord = {
			id: this.newId(),
			kind: input.kind,
			...(input.project === undefined ? {} : { project: input.project }),
			...(input.service === undefined ? {} : { service: input.service }),
			state: "running",
			events: [],
			listeners: new Set(),
			settled,
			resolveSettled,
		};
		this.ops.set(record.id, record);
		const project = input.project;
		if (project === undefined) {
			void this.consume(record, input.run);
			return record.id;
		}
		const previous = this.lanes.get(project);
		if (previous !== undefined) {
			this.push(record, {
				kind: "step",
				message: `Waiting for the previous operation on ${project} to finish`,
			});
		}
		const tail = (previous ?? Promise.resolve()).then(() =>
			this.consume(record, input.run),
		);
		this.lanes.set(project, tail);
		void tail.then(() => {
			if (this.lanes.get(project) === tail) this.lanes.delete(project);
		});
		return record.id;
	}

	/**
	 * Runs `run` in the project's lane: it starts once every operation
	 * started earlier on that project settled, and operations started while
	 * it runs wait for it. For direct (non-`202`) writes that must not
	 * interleave with a running op, e.g. deleting a snapshot a restore is
	 * reading.
	 *
	 * @param project - Project name.
	 * @param run - The work.
	 * @returns What `run` resolves to; its rejection is passed through (the
	 *   lane itself continues).
	 */
	exclusive<T>(project: string, run: () => Promise<T>): Promise<T> {
		const previous = this.lanes.get(project) ?? Promise.resolve();
		const result = previous.then(run);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.lanes.set(project, tail);
		void tail.then(() => {
			if (this.lanes.get(project) === tail) this.lanes.delete(project);
		});
		return result;
	}

	/**
	 * Replays the buffered events of an operation to `listener`, then streams
	 * the live ones.
	 *
	 * @param id - Operation id.
	 * @param listener - Receives events in order.
	 * @returns An unsubscribe function, or `undefined` when the id is unknown or expired.
	 */
	subscribe(id: string, listener: OpListener): (() => void) | undefined {
		this.prune();
		const record = this.ops.get(id);
		if (record === undefined) return undefined;
		for (const event of [...record.events]) listener(event);
		if (record.state === "running") record.listeners.add(listener);
		return () => {
			record.listeners.delete(listener);
		};
	}

	/**
	 * @param id - Operation id.
	 * @returns Its public view, or `undefined` when unknown or expired.
	 */
	get(id: string): OpInfo | undefined {
		this.prune();
		const record = this.ops.get(id);
		return record === undefined ? undefined : info(record);
	}

	/** @returns Every retained operation, oldest first. */
	list(): OpInfo[] {
		this.prune();
		return [...this.ops.values()].map(info);
	}

	/**
	 * @param id - Operation id.
	 * @returns Resolves once the operation emitted its terminal event (immediately when unknown).
	 */
	async settled(id: string): Promise<OpInfo | undefined> {
		const record = this.ops.get(id);
		if (record === undefined) return undefined;
		await record.settled;
		return info(record);
	}

	/**
	 * Registers a callback run after each operation's terminal event.
	 *
	 * @param listener - Receives the settled operation.
	 * @returns An unregister function.
	 */
	onSettled(listener: (op: OpInfo) => void): () => void {
		this.settledListeners.add(listener);
		return () => {
			this.settledListeners.delete(listener);
		};
	}

	private async consume(
		record: OpRecord,
		run: () => AsyncIterable<Progress>,
	): Promise<void> {
		const journal = this.journal;
		if (journal !== undefined && record.project !== undefined) {
			const project = record.project;
			record.journaled = safely(() =>
				journal.start({
					id: record.id,
					project,
					...(record.service === undefined ? {} : { service: record.service }),
					kind: record.kind,
					startedAt: new Date(this.now()).toISOString(),
				}),
			);
			await record.journaled;
		}
		try {
			for await (const event of run()) {
				this.push(record, event);
				if (record.state !== "running") break;
			}
		} catch (error) {
			if (record.state === "running") {
				const failure = isOpError(error)
					? toProgressError(error)
					: { code: "UNKNOWN", message: "The operation failed unexpectedly" };
				this.push(record, {
					kind: "error",
					message: failure.message,
					error: failure,
				});
			}
		}
		if (record.state === "running")
			this.push(record, { kind: "done", message: "Done" });
	}

	private push(record: OpRecord, event: Progress): void {
		if (record.state !== "running") return;
		const stamped: Progress = {
			...event,
			opId: record.id,
			at: event.at ?? new Date(this.now()).toISOString(),
		};
		record.events.push(stamped);
		if (record.events.length > this.maxEvents) record.events.shift();
		for (const listener of [...record.listeners]) {
			try {
				listener(stamped);
			} catch {
				// A failing subscriber must not break the op or other subscribers.
			}
		}
		if (stamped.kind === "done" || stamped.kind === "error") {
			record.state = stamped.kind;
			record.finishedAt = this.now();
			record.listeners.clear();
			record.resolveSettled();
			this.journalFinish(record, stamped);
			const view = info(record);
			for (const listener of [...this.settledListeners]) {
				try {
					listener(view);
				} catch {
					// Settled hooks are best effort.
				}
			}
		}
	}

	private journalFinish(record: OpRecord, terminal: Progress): void {
		const journal = this.journal;
		const started = record.journaled;
		if (journal === undefined || started === undefined) return;
		const finishedAt = new Date(this.now()).toISOString();
		const failed = terminal.kind === "error";
		void started.then(() =>
			safely(() =>
				journal.finish(record.id, {
					status: failed ? "failed" : "succeeded",
					finishedAt,
					...(failed
						? {
								error: terminal.error ?? {
									code: "UNKNOWN",
									message: terminal.message,
								},
							}
						: {}),
				}),
			),
		);
	}

	/** Drops expired ops, then the oldest finished ones until `reserve` slots are free. */
	private prune(reserve = 0): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [id, record] of this.ops) {
			if (record.finishedAt !== undefined && record.finishedAt < cutoff)
				this.ops.delete(id);
		}
		const limit = this.capacity - reserve;
		for (const [id, record] of this.ops) {
			if (this.ops.size <= limit) break;
			if (record.state !== "running") this.ops.delete(id);
		}
	}
}

function info(record: OpRecord): OpInfo {
	return {
		id: record.id,
		kind: record.kind,
		...(record.project === undefined ? {} : { project: record.project }),
		...(record.service === undefined ? {} : { service: record.service }),
		state: record.state,
		eventCount: record.events.length,
	};
}
