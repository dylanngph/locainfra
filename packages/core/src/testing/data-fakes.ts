import type {
	ContainerExec,
	ExecOptions,
	ExecResult,
} from "../ports/exec.port";
import type { OpFinish, OpJournal, OpStart } from "../ports/op-journal.port";
import type {
	SnapshotIndex,
	SnapshotRecord,
	VolumeArchiver,
} from "../ports/snapshot.port";
import type { Progress } from "../shared/progress.model";

/** One recorded {@link FakeContainerExec.run} call. */
export interface ExecCall {
	/** Container id or name. */
	readonly containerId: string;
	/** Command and arguments. */
	readonly argv: readonly string[];
	/** Options passed. */
	readonly options: ExecOptions;
}

/** Answer of a {@link FakeContainerExec} script: a result, or an error to reject with. */
export type ExecScript =
	| Partial<ExecResult>
	| Error
	| ((call: ExecCall) => Partial<ExecResult> | Error);

/**
 * {@link ContainerExec} that records calls and answers from a script. The
 * first matching entry of `scripts` (by `argv[0]`, e.g. `psql`) wins, else
 * `defaultScript`. Partial results are completed with exit code 0, empty
 * output, not truncated, not timed out.
 */
export class FakeContainerExec implements ContainerExec {
	/** Every call, in order. */
	readonly calls: ExecCall[] = [];
	/** Answers by command name (`argv[0]`). */
	readonly scripts = new Map<string, ExecScript>();
	/** Answer when no script matches. */
	defaultScript: ExecScript = {};

	/** @inheritdoc */
	async run(
		containerId: string,
		argv: readonly string[],
		options: ExecOptions,
	): Promise<ExecResult> {
		const call: ExecCall = { containerId, argv: [...argv], options };
		this.calls.push(call);
		const script = this.scripts.get(argv[0] ?? "") ?? this.defaultScript;
		const answer = typeof script === "function" ? script(call) : script;
		if (answer instanceof Error) throw answer;
		return {
			exitCode: 0,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut: false,
			...answer,
		};
	}
}

/** Script of one {@link FakeVolumeArchiver} call: events, or an error to throw. */
export type ArchiverScript = readonly Progress[] | Error;

/** One recorded archive/restore call of {@link FakeVolumeArchiver}. */
export interface ArchiverCall {
	/** Docker volume name. */
	readonly volume: string;
	/** Archive path (destination for archive, source for restore). */
	readonly path: string;
}

/**
 * {@link VolumeArchiver} that records calls and replays scripted progress.
 * A successful `archive` (script without an `error` event) registers the
 * file in `archives` with `sizeBytes` before replaying (so it exists when
 * `done` arrives); `removeArchive` deletes it.
 */
export class FakeVolumeArchiver implements VolumeArchiver {
	/** `archive` calls. */
	readonly archiveCalls: ArchiverCall[] = [];
	/** `restore` calls. */
	readonly restoreCalls: ArchiverCall[] = [];
	/** `removeArchive` calls (paths). */
	readonly removed: string[] = [];
	/** Existing archive files: path → size in bytes. */
	readonly archives = new Map<string, number>();
	/** Events (or a thrown error) for `archive`. */
	archiveScript: ArchiverScript = [{ kind: "done", message: "Archived" }];
	/** Events (or a thrown error) for `restore`. */
	restoreScript: ArchiverScript = [{ kind: "done", message: "Restored" }];
	/** Size recorded for archives written by `archive`. */
	sizeBytes = 1024;

	/** @inheritdoc */
	async *archive(
		volume: string,
		destPath: string,
		_signal: AbortSignal,
	): AsyncIterable<Progress> {
		this.archiveCalls.push({ volume, path: destPath });
		const script = this.archiveScript;
		// Like a real adapter, the file exists by the time `done` is yielded
		// (callers stop reading after the terminal event).
		if (!(script instanceof Error) && !script.some((e) => e.kind === "error")) {
			this.archives.set(destPath, this.sizeBytes);
		}
		yield* replayArchiver(script);
	}

	/** @inheritdoc */
	async *restore(
		volume: string,
		srcPath: string,
		_signal: AbortSignal,
	): AsyncIterable<Progress> {
		this.restoreCalls.push({ volume, path: srcPath });
		yield* replayArchiver(this.restoreScript);
	}

	/** @inheritdoc */
	async sizeOf(path: string): Promise<number> {
		const size = this.archives.get(path);
		if (size === undefined) throw new Error(`ENOENT: ${path}`);
		return size;
	}

	/** @inheritdoc */
	async removeArchive(path: string): Promise<void> {
		this.removed.push(path);
		this.archives.delete(path);
	}
}

async function* replayArchiver(
	script: ArchiverScript,
): AsyncIterable<Progress> {
	if (script instanceof Error) throw script;
	for (const event of script) yield event;
}

/** In-memory {@link SnapshotIndex}; `list` sorts newest first by `createdAt`. */
export class FakeSnapshotIndex implements SnapshotIndex {
	/** Id → row. */
	readonly rows = new Map<string, SnapshotRecord>();

	/** @param initial - Initial rows. */
	constructor(initial: readonly SnapshotRecord[] = []) {
		for (const row of initial) this.rows.set(row.id, { ...row });
	}

	/** @inheritdoc */
	async list(project: string, service: string): Promise<SnapshotRecord[]> {
		return [...this.rows.values()]
			.filter((row) => row.project === project && row.service === service)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((row) => ({ ...row }));
	}

	/** @inheritdoc */
	async get(id: string): Promise<SnapshotRecord | null> {
		const row = this.rows.get(id);
		return row === undefined ? null : { ...row };
	}

	/** @inheritdoc */
	async insert(record: SnapshotRecord): Promise<void> {
		if (this.rows.has(record.id)) {
			throw new Error(`UNIQUE constraint failed: snapshots.id (${record.id})`);
		}
		this.rows.set(record.id, { ...record });
	}

	/** @inheritdoc */
	async delete(id: string): Promise<boolean> {
		return this.rows.delete(id);
	}
}

/** One row of {@link InMemoryOpJournal}. */
export interface JournalRow extends OpStart {
	/** Current status. */
	status: OpFinish["status"];
	/** End time, once finished. */
	finishedAt?: string;
	/** Secret-free error of a failed op. */
	error?: OpFinish["error"];
}

/** In-memory {@link OpJournal}; `failWith` makes every call reject. */
export class InMemoryOpJournal implements OpJournal {
	/** Id → row, in start order. */
	readonly rows = new Map<string, JournalRow>();
	/** When set, `start` and `finish` reject with it. */
	failWith: Error | undefined;

	/** @inheritdoc */
	async start(start: OpStart): Promise<void> {
		if (this.failWith !== undefined) throw this.failWith;
		this.rows.set(start.id, { ...start, status: "running" });
	}

	/** @inheritdoc */
	async finish(id: string, finish: OpFinish): Promise<void> {
		if (this.failWith !== undefined) throw this.failWith;
		const row = this.rows.get(id);
		if (row === undefined) throw new Error(`unknown op ${id}`);
		this.rows.set(id, { ...row, ...finish });
	}
}
