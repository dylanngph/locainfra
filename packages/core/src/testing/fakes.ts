import type { ServiceDefinition } from "../catalog/catalog.model";
import type { CatalogSource } from "../catalog/catalog.source";
import type {
	ComposeDownInput,
	ComposeInfoPort,
	ComposePsInput,
	ComposeServiceStatus,
	ComposeUpInput,
	LifecycleRunner,
} from "../ports/compose.port";
import type {
	ContainerFilter,
	ContainerReader,
	ContainerSummary,
	DockerInfo,
	DockerInfoPort,
	SocketLocator,
} from "../ports/docker.port";
import type {
	Clock,
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
		return this.files.get(path) ?? null;
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
	async mkdirp(path: string): Promise<void> {
		this.dirs.add(path);
		this.addParents(path);
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
	/** Events (or a thrown error) for `up`. */
	upScript: LifecycleScript = [{ kind: "done", message: "Started" }];
	/** Events (or a thrown error) for `down`. */
	downScript: LifecycleScript = [{ kind: "done", message: "Stopped" }];
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
