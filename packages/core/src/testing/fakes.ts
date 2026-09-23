import type { ServiceDefinition } from "../catalog/catalog.model";
import type { CatalogSource } from "../catalog/catalog.source";
import type {
	ComposeDownInput,
	ComposeInfoPort,
	ComposePsInput,
	ComposeRemoveInput,
	ComposeServiceStatus,
	ComposeServicesInput,
	ComposeUpInput,
	LifecycleRunner,
} from "../ports/compose.port";
import type {
	BrowserOpener,
	FolderPicker,
	FolderPickOptions,
} from "../ports/desktop.port";
import type {
	ContainerDetails,
	ContainerFilter,
	ContainerInspector,
	ContainerReader,
	ContainerStreams,
	ContainerSummary,
	DockerEvent,
	DockerInfo,
	DockerInfoPort,
	EventFilter,
	LogLine,
	LogOptions,
	SocketLocator,
	StatsSample,
} from "../ports/docker.port";
import type {
	Clock,
	FileInfo,
	FileStore,
	PortProbe,
	SecretGenerator,
	WriteTextOptions,
} from "../ports/files.port";
import type { Paths } from "../ports/paths.port";
import type { SecretStore } from "../ports/secrets.port";
import {
	createEmptyState,
	type StateFile,
	type StateReader,
	type StateWriter,
} from "../ports/state.port";
import type { Progress } from "../shared/progress.model";

/**
 * In-memory {@link FileStore}. Paths are used verbatim (no normalisation);
 * `writeText` records every parent directory.
 */
export class InMemoryFileStore implements FileStore {
	/** File path → contents. */
	readonly files = new Map<string, string>();
	/** Known directories. */
	readonly dirs = new Set<string>();
	/** File path → permission bits passed to the last `writeText` with a `mode`. */
	readonly modes = new Map<string, number>();
	/**
	 * Simulated symlinks: link path → target path. `fileInfo` and `readText`
	 * follow them (one hop); a target that is not a known file or directory
	 * reports kind `other` (a device, FIFO, …) with {@link InMemoryFileStore.sizes}.
	 */
	readonly links = new Map<string, string>();
	/** Size overrides (path → bytes) reported by `fileInfo`. */
	readonly sizes = new Map<string, number>();

	/** @param files - Initial files (path → contents). */
	constructor(files: Readonly<Record<string, string>> = {}) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, content);
			this.addParents(path);
		}
	}

	private addParents(path: string): void {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/") || "/";
			this.dirs.add(dir);
		}
	}

	/** @inheritdoc */
	async readText(path: string): Promise<string | null> {
		return this.files.get(this.links.get(path) ?? path) ?? null;
	}

	/** @inheritdoc */
	async writeText(
		path: string,
		content: string,
		options?: WriteTextOptions,
	): Promise<void> {
		this.files.set(path, content);
		if (options?.mode !== undefined) this.modes.set(path, options.mode);
		this.addParents(path);
	}

	/** @inheritdoc */
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}

	/** @inheritdoc */
	async isDirectory(path: string): Promise<boolean> {
		return this.dirs.has(path);
	}

	/** @inheritdoc */
	async mkdirp(path: string): Promise<void> {
		this.dirs.add(path);
		this.addParents(path);
	}

	/** @inheritdoc */
	async fileInfo(path: string): Promise<FileInfo | null> {
		const realPath = this.links.get(path) ?? path;
		const content = this.files.get(realPath);
		if (content !== undefined) {
			return {
				realPath,
				kind: "file",
				sizeBytes:
					this.sizes.get(realPath) ?? Buffer.byteLength(content, "utf8"),
			};
		}
		if (this.dirs.has(realPath)) {
			return { realPath, kind: "directory", sizeBytes: 0 };
		}
		if (this.links.has(path)) {
			return {
				realPath,
				kind: "other",
				sizeBytes: this.sizes.get(realPath) ?? 0,
			};
		}
		return null;
	}
}

/** In-memory {@link StateReader} & {@link StateWriter}; counts updates. */
export class InMemoryStateStore implements StateReader, StateWriter {
	/** Current state. */
	state: StateFile;
	/** Number of `update` calls. */
	updates = 0;

	/** @param initial - Initial state (defaults to empty). */
	constructor(initial: StateFile = createEmptyState()) {
		this.state = structuredClone(initial);
	}

	/** @inheritdoc */
	async read(): Promise<StateFile> {
		return structuredClone(this.state);
	}

	/** @inheritdoc */
	async update(mutate: (state: StateFile) => StateFile): Promise<StateFile> {
		this.updates++;
		this.state = structuredClone(mutate(structuredClone(this.state)));
		return structuredClone(this.state);
	}
}

/** In-memory {@link SecretStore}; counts writes. */
export class InMemorySecretStore implements SecretStore {
	/** Stack name → secrets. */
	readonly stacks = new Map<string, Record<string, string>>();
	/** Number of `write` calls. */
	writes = 0;

	/** @param initial - Initial secrets per stack. */
	constructor(initial: Readonly<Record<string, Record<string, string>>> = {}) {
		for (const [stack, secrets] of Object.entries(initial)) {
			this.stacks.set(stack, { ...secrets });
		}
	}

	/** @inheritdoc */
	async read(stack: string): Promise<Record<string, string>> {
		return { ...(this.stacks.get(stack) ?? {}) };
	}

	/** @inheritdoc */
	async write(stack: string, secrets: Record<string, string>): Promise<void> {
		this.writes++;
		this.stacks.set(stack, { ...secrets });
	}

	/** @inheritdoc */
	async update(
		stack: string,
		mutate: (
			current: Record<string, string>,
		) => Record<string, string> | undefined,
	): Promise<Record<string, string>> {
		// Synchronous read-modify-write: atomic within the event loop, like a lock.
		const next = mutate({ ...(this.stacks.get(stack) ?? {}) });
		if (next !== undefined) {
			this.writes++;
			this.stacks.set(stack, { ...next });
		}
		return { ...(this.stacks.get(stack) ?? {}) };
	}
}

/** {@link PortProbe} that reports the given ports as busy; records probes. */
export class FakePortProbe implements PortProbe {
	/** Ports reported as in use. */
	readonly busy: Set<number>;
	/** Every probed port, in order. */
	readonly probed: number[] = [];

	/** @param busy - Ports reported as in use. */
	constructor(busy: Iterable<number> = []) {
		this.busy = new Set(busy);
	}

	/** @inheritdoc */
	async isFree(port: number): Promise<boolean> {
		this.probed.push(port);
		return !this.busy.has(port);
	}
}

/** {@link Clock} frozen at a fixed instant (settable). */
export class FixedClock implements Clock {
	/** The instant returned by `now()`. */
	current: Date;

	/** @param iso - Initial instant (ISO-8601). */
	constructor(iso = "2026-09-23T00:00:00.000Z") {
		this.current = new Date(iso);
	}

	/** @inheritdoc */
	now(): Date {
		return new Date(this.current.getTime());
	}
}

/**
 * Deterministic {@link SecretGenerator}: `<prefix>-<n>-` padded with `x` to a
 * URL-safe string as long as base64url of `bytes` bytes.
 */
export class SequentialSecretGenerator implements SecretGenerator {
	/** Number of secrets generated so far. */
	count = 0;
	/** Requested byte sizes, in order. */
	readonly sizes: number[] = [];

	/** @param prefix - Prefix of generated values. */
	constructor(private readonly prefix = "secret") {}

	/** @inheritdoc */
	generate(bytes: number): string {
		this.count++;
		this.sizes.push(bytes);
		const length = Math.ceil((bytes * 4) / 3);
		return `${this.prefix}-${this.count}-`.padEnd(length, "x");
	}
}

/** Script of one {@link FakeLifecycleRunner} call. */
export type LifecycleScript = readonly Progress[] | Error;

/** {@link LifecycleRunner} that records calls and replays scripted progress. */
export class FakeLifecycleRunner implements LifecycleRunner {
	/** Inputs of `up` calls. */
	readonly upCalls: ComposeUpInput[] = [];
	/** Inputs of `down` calls. */
	readonly downCalls: ComposeDownInput[] = [];
	/** Inputs of `ps` calls. */
	readonly psCalls: ComposePsInput[] = [];
	/** Inputs of `start` calls. */
	readonly startCalls: ComposeServicesInput[] = [];
	/** Inputs of `stop` calls. */
	readonly stopCalls: ComposeServicesInput[] = [];
	/** Inputs of `restart` calls. */
	readonly restartCalls: ComposeServicesInput[] = [];
	/** Inputs of `remove` calls. */
	readonly removeCalls: ComposeRemoveInput[] = [];
	/** Events (or a thrown error) for `up`. */
	upScript: LifecycleScript = [{ kind: "done", message: "Started" }];
	/** Events (or a thrown error) for `down`. */
	downScript: LifecycleScript = [{ kind: "done", message: "Stopped" }];
	/** Events (or a thrown error) for `start`. */
	startScript: LifecycleScript = [{ kind: "done", message: "Started" }];
	/** Events (or a thrown error) for `stop`. */
	stopScript: LifecycleScript = [{ kind: "done", message: "Stopped" }];
	/** Events (or a thrown error) for `restart`. */
	restartScript: LifecycleScript = [{ kind: "done", message: "Restarted" }];
	/** Events (or a thrown error) for `remove`. */
	removeScript: LifecycleScript = [{ kind: "done", message: "Removed" }];
	/** Rows returned by `ps`. */
	psRows: ComposeServiceStatus[] = [];

	/** @inheritdoc */
	async *up(input: ComposeUpInput): AsyncIterable<Progress> {
		this.upCalls.push(input);
		yield* replay(this.upScript);
	}

	/** @inheritdoc */
	async *down(input: ComposeDownInput): AsyncIterable<Progress> {
		this.downCalls.push(input);
		yield* replay(this.downScript);
	}

	/** @inheritdoc */
	async *start(input: ComposeServicesInput): AsyncIterable<Progress> {
		this.startCalls.push(input);
		yield* replay(this.startScript);
	}

	/** @inheritdoc */
	async *stop(input: ComposeServicesInput): AsyncIterable<Progress> {
		this.stopCalls.push(input);
		yield* replay(this.stopScript);
	}

	/** @inheritdoc */
	async *restart(input: ComposeServicesInput): AsyncIterable<Progress> {
		this.restartCalls.push(input);
		yield* replay(this.restartScript);
	}

	/** @inheritdoc */
	async *remove(input: ComposeRemoveInput): AsyncIterable<Progress> {
		this.removeCalls.push(input);
		yield* replay(this.removeScript);
	}

	/** @inheritdoc */
	async ps(input: ComposePsInput): Promise<ComposeServiceStatus[]> {
		this.psCalls.push(input);
		return this.psRows;
	}
}

async function* replay(script: LifecycleScript): AsyncIterable<Progress> {
	if (script instanceof Error) throw script;
	for (const event of script) yield event;
}

/** {@link DockerInfoPort} returning fixed info, or rejecting with `error`. */
export class FakeDockerInfo implements DockerInfoPort {
	/** Daemon info returned by `info()`. */
	value: DockerInfo = {
		serverVersion: "29.6.1",
		apiVersion: "1.55",
		platformName: "Docker Desktop 4.82.0",
		os: "linux",
		arch: "aarch64",
	};
	/** When set, `info()` rejects with it. */
	error: Error | undefined;

	/** @inheritdoc */
	async info(): Promise<DockerInfo> {
		if (this.error) throw this.error;
		return { ...this.value };
	}
}

/** {@link ComposeInfoPort} returning a fixed version (`null` = missing). */
export class FakeComposeInfo implements ComposeInfoPort {
	/** @param current - Version returned by `version()`. */
	constructor(public current: string | null = "5.3.0") {}

	/** @inheritdoc */
	async version(): Promise<string | null> {
		return this.current;
	}
}

/** {@link SocketLocator} returning a fixed path (`null` = not found). */
export class FakeSocketLocator implements SocketLocator {
	/** @param path - Path returned by `locate()`. */
	constructor(
		public path: string | null = "/home/test/.docker/run/docker.sock",
	) {}

	/** @inheritdoc */
	async locate(): Promise<string | null> {
		return this.path;
	}
}

/** {@link ContainerReader} over a fixed list, honouring label filters. */
export class FakeContainerReader implements ContainerReader {
	/** @param containers - Containers to list. */
	constructor(public containers: ContainerSummary[] = []) {}

	/** @inheritdoc */
	async list(filter: ContainerFilter): Promise<ContainerSummary[]> {
		const wanted = Object.entries(filter.labels ?? {});
		return this.containers.filter((c) =>
			wanted.every(([key, value]) => c.labels[key] === value),
		);
	}
}

/** {@link ContainerInspector} over a fixed map of containers (by id or name). */
export class FakeContainerInspector implements ContainerInspector {
	/** Every inspected id, in order. */
	readonly inspected: string[] = [];

	/** @param containers - Containers to return. */
	constructor(public containers: ContainerDetails[] = []) {}

	/** @inheritdoc */
	async inspect(id: string): Promise<ContainerDetails | null> {
		this.inspected.push(id);
		const found = this.containers.find((c) => c.id === id || c.name === id);
		return found === undefined ? null : structuredClone(found);
	}
}

/** One recorded {@link FakeContainerStreams.logs} call. */
export interface LogsCall {
	/** Container id. */
	readonly id: string;
	/** Options passed. */
	readonly options: LogOptions;
}

/**
 * Scripted {@link ContainerStreams}: replays the configured items per
 * container, then (for follow/stats/events) waits until the signal aborts.
 * `push*` methods feed live items to open streams.
 */
export class FakeContainerStreams implements ContainerStreams {
	/** Container id → log lines replayed by `logs`. */
	readonly logLines = new Map<string, LogLine[]>();
	/** Container id → samples replayed by `stats`. */
	readonly samples = new Map<string, StatsSample[]>();
	/** Events replayed by `events` (label filter applied to `attributes`). */
	scriptedEvents: DockerEvent[] = [];
	/** Recorded `logs` calls. */
	readonly logsCalls: LogsCall[] = [];
	/** Recorded `stats` calls (container ids). */
	readonly statsCalls: string[] = [];
	/** Recorded `events` filters. */
	readonly eventsCalls: EventFilter[] = [];
	/** Number of currently open streams (to assert upstream sharing/cancellation). */
	open = 0;
	private readonly listeners = new Set<
		(kind: string, id: string, item: unknown) => void
	>();

	/**
	 * Feeds a live log line to open `follow` streams of `id`.
	 *
	 * @param id - Container id.
	 * @param line - Line to deliver.
	 */
	pushLog(id: string, line: LogLine): void {
		for (const listener of this.listeners) listener("log", id, line);
	}

	/**
	 * Feeds a live sample to open `stats` streams of `id`.
	 *
	 * @param id - Container id.
	 * @param sample - Sample to deliver.
	 */
	pushStats(id: string, sample: StatsSample): void {
		for (const listener of this.listeners) listener("stats", id, sample);
	}

	/**
	 * Feeds a live event to open `events` streams.
	 *
	 * @param event - Event to deliver.
	 */
	pushEvent(event: DockerEvent): void {
		for (const listener of this.listeners) listener("event", event.id, event);
	}

	/** @inheritdoc */
	logs(id: string, options: LogOptions): AsyncIterable<LogLine> {
		this.logsCalls.push({ id, options });
		const initial = this.logLines.get(id) ?? [];
		const tail =
			options.tail === undefined ? initial : initial.slice(-options.tail);
		return this.stream<LogLine>(
			"log",
			id,
			tail,
			options.follow,
			options.signal,
		);
	}

	/** @inheritdoc */
	stats(id: string, signal: AbortSignal): AsyncIterable<StatsSample> {
		this.statsCalls.push(id);
		return this.stream<StatsSample>(
			"stats",
			id,
			this.samples.get(id) ?? [],
			true,
			signal,
		);
	}

	/** @inheritdoc */
	events(filter: EventFilter, signal: AbortSignal): AsyncIterable<DockerEvent> {
		this.eventsCalls.push(filter);
		const wanted = Object.entries(filter.labels ?? {});
		const matches = (e: DockerEvent) =>
			wanted.every(([key, value]) => e.attributes[key] === value);
		return this.stream<DockerEvent>(
			"event",
			undefined,
			this.scriptedEvents.filter(matches),
			true,
			signal,
			(item) => matches(item),
		);
	}

	private async *stream<T>(
		kind: string,
		id: string | undefined,
		initial: readonly T[],
		follow: boolean,
		signal: AbortSignal | undefined,
		accept: (item: T) => boolean = () => true,
	): AsyncIterable<T> {
		this.open++;
		const queue: T[] = [];
		let wake: (() => void) | undefined;
		const listener = (k: string, target: string, item: unknown) => {
			if (k !== kind || (id !== undefined && target !== id)) return;
			const typed = item as T;
			if (!accept(typed)) return;
			queue.push(typed);
			wake?.();
		};
		const onAbort = () => wake?.();
		try {
			for (const item of initial) {
				if (signal?.aborted) return;
				yield item;
			}
			if (!follow) return;
			this.listeners.add(listener);
			signal?.addEventListener("abort", onAbort);
			while (!signal?.aborted) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = undefined;
			}
		} finally {
			this.listeners.delete(listener);
			signal?.removeEventListener("abort", onAbort);
			this.open--;
		}
	}
}

/** {@link FolderPicker} returning a fixed answer; records calls. */
export class FakeFolderPicker implements FolderPicker {
	/** Options of every `pick` call. */
	readonly calls: FolderPickOptions[] = [];

	/** @param answer - Path returned by `pick` (`null` = cancelled). */
	constructor(public answer: string | null = null) {}

	/** @inheritdoc */
	async pick(options: FolderPickOptions): Promise<string | null> {
		this.calls.push(options);
		return this.answer;
	}
}

/** {@link BrowserOpener} that records opened URLs. */
export class FakeBrowserOpener implements BrowserOpener {
	/** Every opened URL, in order. */
	readonly opened: string[] = [];

	/** @inheritdoc */
	async open(url: string): Promise<void> {
		this.opened.push(url);
	}
}

/** {@link CatalogSource} over a fixed list of definitions. */
export class StaticCatalogSource implements CatalogSource {
	/** @param items - Definitions returned by `definitions()`. */
	constructor(public items: ServiceDefinition[] = []) {}

	/** @inheritdoc */
	async definitions(): Promise<ServiceDefinition[]> {
		return [...this.items];
	}
}

/**
 * @param home - Fake home directory.
 * @returns {@link Paths} rooted at `<home>/.locainfra`.
 */
export function createTestPaths(home = "/home/test"): Paths {
	const stateDir = `${home}/.locainfra`;
	return {
		home,
		stateDir,
		stacksDir: `${stateDir}/stacks`,
		secretsDir: `${stateDir}/secrets`,
		registryDir: `${stateDir}/registry`,
		catalogOverridesDir: `${stateDir}/catalog`,
	};
}
