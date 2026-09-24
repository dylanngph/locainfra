import {
	type CatalogListing,
	type ConnectionInfo,
	createEmptyState,
	type DataObjects,
	type DataQueryResult,
	type EnvPreview,
	err,
	type ImportItem,
	type ImportPreview,
	MASKED_SECRET,
	OpError,
	ok,
	type Progress,
	type ProjectStatus,
	type ProjectSummary,
	runDoctor,
	type ServiceDetail,
	type SetupPlan,
	type Snapshot,
	type SnapshotRecord,
	type Stack,
} from "@locastack/core";
import {
	createPlatformFacts,
	createProjectStack,
	createTestPaths,
	FakeComposeInfo,
	FakeContainerExec,
	FakeContainerInspector,
	FakeContainerReader,
	FakeContainerStreams,
	FakeDaemonWaiter,
	FakeDockerInfo,
	FakeFolderPicker,
	FakeLifecycleRunner,
	FakePlatformInspector,
	FakePortProbe,
	FakeProcessRunner,
	FakeSnapshotIndex,
	FakeSocketLocator,
	FakeVolumeArchiver,
	FixedClock,
	InMemoryFileStore,
	InMemoryOpJournal,
	InMemorySecretStore,
	InMemoryStateStore,
	postgresDefinition,
	SequentialSecretGenerator,
	StaticCatalogSource,
} from "@locastack/core/testing";
import type { ServerDeps } from "../../app";
import type { ServerOps, ServerPorts } from "../../deps";

/** Host the tests address the app on. */
export const HOST = "127.0.0.1:4488";
/** Session token of the test app. */
export const TOKEN = "secret";
/** The one registered project of the fixtures. */
export const PROJECT = "shop-api";
/** Container id of `main-db`. */
export const CONTAINER = "c0ffee01";

/** Stack of {@link PROJECT}: one Postgres instance `main-db`. */
export const stack: Stack = createProjectStack(PROJECT, {
	"main-db": { type: "postgres", version: "17", port: 5433 },
});

/** Status of {@link PROJECT}. */
export const status: ProjectStatus = {
	project: PROJECT,
	network: `ls-${PROJECT}`,
	services: [
		{
			name: "main-db",
			type: "postgres",
			version: "17",
			image: "postgres:17-alpine",
			hostPort: 5433,
			containerPort: 5432,
			containerName: `ls-${PROJECT}-main-db`,
			containerId: CONTAINER,
			persist: "volume",
			state: "running",
			health: "healthy",
			startedAt: "2026-09-23T07:00:00.000Z",
		},
	],
};

/** Detail of `main-db`. */
export const detail: ServiceDetail = {
	...(status.services[0] as ProjectStatus["services"][number]),
	network: `ls-${PROJECT}`,
	config: { POSTGRES_USER: "postgres", POSTGRES_DB: "shop" },
	secretNames: ["POSTGRES_PASSWORD"],
	volumes: [
		{
			name: `ls-${PROJECT}-main-db-data`,
			source: "data",
			path: "/var/lib/postgresql/data",
		},
	],
};

/** Summary of {@link PROJECT}. */
export const summary: ProjectSummary = {
	name: PROJECT,
	root: stack.root,
	serviceCount: 1,
	running: 1,
	errors: 0,
	types: ["postgres"],
};

/** Catalog listing with Postgres only. */
export const listing: CatalogListing = {
	definitions: [postgresDefinition],
	categories: [
		{ id: "database", label: "Database", category: "database", count: 1 },
	],
};

const url = (reveal: boolean) =>
	`postgres://postgres:${reveal ? "pw" : MASKED_SECRET}@127.0.0.1:5433/shop`;

/** Connect tab data of `main-db`. */
export const connection = (reveal: boolean): ConnectionInfo => ({
	primary: { key: "DATABASE_URL", value: url(reveal) },
	exports: [{ key: "DATABASE_URL", value: url(reveal) }],
	details: [{ k: "Host", v: "127.0.0.1" }],
	snippets: { env: `DATABASE_URL=${url(reveal)}` },
});

/** Env preview of {@link PROJECT}. */
export const preview = (format: EnvPreview["format"]): EnvPreview => ({
	format,
	lines: [
		{
			key: "DATABASE_URL",
			value: url(false),
			service: "main-db",
			type: "postgres",
		},
	],
	text: `# main-db (postgres)\nDATABASE_URL=${url(false)}\n`,
	serviceCount: 1,
	file: ".env",
});

/** Data tab object list of `main-db`. */
export const dataObjects: DataObjects = {
	kind: "sql",
	label: "Tables",
	objects: [
		{ name: "users", defaultQuery: 'SELECT *\nFROM "users"\nLIMIT 100;' },
	],
	truncated: false,
};

/** Result of every stubbed query. */
export const queryResult: DataQueryResult = {
	columns: ["id", "email"],
	rows: [
		["1", "a@example.com"],
		["2", "b@example.com"],
	],
	rowCount: 2,
	truncated: false,
	durationMs: 7,
};

/** Id of the one snapshot of `main-db`. */
export const SNAPSHOT_ID = "AbC_12-x";

/** Index row of the one snapshot of `main-db`. */
export const snapshotRecord: SnapshotRecord = {
	id: SNAPSHOT_ID,
	project: PROJECT,
	service: "main-db",
	name: "clean-seed",
	path: `/home/test/.locastack/snapshots/${PROJECT}/main-db/${SNAPSHOT_ID}.tgz`,
	sizeBytes: 12_000_000,
	createdAt: "2026-09-22T08:00:00.000Z",
};

/** The one snapshot of `main-db`, as the API shows it. */
export const snapshot: Snapshot = {
	id: SNAPSHOT_ID,
	service: "main-db",
	name: "clean-seed",
	sizeBytes: 12_000_000,
	createdAt: "2026-09-22T08:00:00.000Z",
};

/** A supported item of the stubbed import preview. */
export const importItem: ImportItem = {
	composeName: "db",
	name: "db",
	image: "postgres:16-alpine",
	type: "postgres",
	version: "16",
	supported: true,
	include: true,
	hostPort: 5433,
	wantedPort: 5432,
	remapNote: "5432 is in use on this machine",
	config: { POSTGRES_DB: "shop" },
	secrets: { POSTGRES_PASSWORD: "example" },
};

/** Stubbed import preview. */
export const importPreview: ImportPreview = {
	suggestedName: "compose-app",
	items: [
		importItem,
		{
			composeName: "api",
			name: "api",
			supported: false,
			skipReason: "build",
			include: false,
			config: {},
			secrets: {},
		},
	],
};

/** Setup plan of a healthy machine (nothing to do). */
export const nonePlan: SetupPlan = {
	kind: "none",
	reason: "Docker is ready.",
	steps: [],
	postNotes: [],
	alternatives: [],
	needsTerminal: false,
	requiresRelogin: false,
};

/** One recorded op call. */
export interface OpCall {
	/** Op name. */
	readonly op: keyof ServerOps;
	/** Input (none for dep-only ops). */
	readonly input?: unknown;
}

/** Progress stream of a successful stubbed long-running op. */
async function* succeed(service?: string): AsyncIterable<Progress> {
	yield { kind: "step", message: "Starting", ...(service ? { service } : {}) };
	yield { kind: "done", message: "Done" };
}

const notFound = (project: string) =>
	err(new OpError("PROJECT_NOT_FOUND", `No project named ${project}`));

/** `PROJECT_NOT_FOUND` / `SERVICE_NOT_FOUND` unless the ref is `shop-api/main-db`. */
const refError = (input: { project: string; name: string }) =>
	input.project !== PROJECT
		? notFound(input.project)
		: input.name !== "main-db"
			? err(new OpError("SERVICE_NOT_FOUND", `No service ${input.name}`))
			: undefined;

/**
 * Stub ops over the fixtures: {@link PROJECT} exists, anything else is
 * `PROJECT_NOT_FOUND`. Every call is recorded in `calls`.
 *
 * @param overrides - Replace individual ops.
 * @returns The ops and the call log.
 */
export function createStubOps(overrides: Partial<ServerOps> = {}): {
	ops: ServerOps;
	calls: OpCall[];
} {
	const calls: OpCall[] = [];
	const record = (op: keyof ServerOps, input?: unknown) =>
		calls.push(input === undefined ? { op } : { op, input });
	const ops: ServerOps = {
		runDoctor,
		getSystemInfo: async () => {
			record("getSystemInfo");
			return {
				docker: { version: "29.6.1", apiVersion: "1.55" },
				compose: "5.3.0",
			};
		},
		catalogList: async () => {
			record("catalogList");
			return ok(listing);
		},
		listProjects: async () => {
			record("listProjects");
			return ok([summary]);
		},
		registerProject: async (_deps, input) => {
			record("registerProject", input);
			return ok({ name: input.name, root: input.root });
		},
		createProject: async (_deps, input) => {
			record("createProject", input);
			if (input.name === PROJECT)
				return err(new OpError("PROJECT_EXISTS", "Already registered"));
			return ok(createProjectStack(input.name, {}));
		},
		unregisterProject: async (_deps, input) => {
			record("unregisterProject", input);
			return input.project === PROJECT
				? ok({ name: PROJECT, root: stack.root })
				: notFound(input.project);
		},
		loadProject: async (_deps, input) => {
			record("loadProject", input);
			return input.project === PROJECT ? ok(stack) : notFound(input.project);
		},
		upProject: (_deps, input) => {
			record("upProject", input);
			return succeed();
		},
		downProject: (_deps, input) => {
			record("downProject", input);
			return succeed();
		},
		statusForProject: async (_deps, input) => {
			record("statusForProject", input);
			return input.project === PROJECT ? ok(status) : notFound(input.project);
		},
		getService: async (_deps, input) => {
			record("getService", input);
			if (input.project !== PROJECT) return notFound(input.project);
			return input.name === "main-db"
				? ok(detail)
				: err(new OpError("SERVICE_NOT_FOUND", `No service ${input.name}`));
		},
		addService: (_deps, input) => {
			record("addService", input);
			return succeed(input.name);
		},
		removeService: (_deps, input) => {
			record("removeService", input);
			return succeed(input.name);
		},
		updateService: (_deps, input) => {
			record("updateService", input);
			return succeed(input.name);
		},
		startService: (_deps, input) => {
			record("startService", input);
			return succeed(input.name);
		},
		stopService: (_deps, input) => {
			record("stopService", input);
			return succeed(input.name);
		},
		restartService: (_deps, input) => {
			record("restartService", input);
			return succeed(input.name);
		},
		envPreview: async (_deps, input) => {
			record("envPreview", input);
			return input.project === PROJECT
				? ok(preview(input.format))
				: notFound(input.project);
		},
		linkEnv: async (_deps, input) => {
			record("linkEnv", input);
			return ok({ path: `${stack.root}/${input.file ?? ".env"}`, count: 1 });
		},
		getConnection: async (_deps, input) => {
			record("getConnection", input);
			return ok(connection(input.reveal));
		},
		listDataObjects: async (_deps, input) => {
			record("listDataObjects", input);
			return refError(input) ?? ok(dataObjects);
		},
		runQuery: async (_deps, input) => {
			record("runQuery", input);
			return refError(input) ?? ok(queryResult);
		},
		listSnapshots: async (_deps, input) => {
			record("listSnapshots", input);
			return refError(input) ?? ok([snapshot]);
		},
		createSnapshot: (_deps, input) => {
			record("createSnapshot", input);
			return succeed(input.name);
		},
		restoreSnapshot: (_deps, input) => {
			record("restoreSnapshot", input);
			return succeed(input.name);
		},
		deleteSnapshot: async (_deps, input) => {
			record("deleteSnapshot", input);
			const failure = refError(input);
			if (failure !== undefined) return failure;
			return input.snapshotId === SNAPSHOT_ID
				? ok(snapshot)
				: err(
						new OpError(
							"SNAPSHOT_NOT_FOUND",
							`No snapshot ${input.snapshotId} for ${input.name}`,
						),
					);
		},
		seedService: (_deps, input) => {
			record("seedService", input);
			return succeed(input.name);
		},
		rotateSecret: (_deps, input) => {
			record("rotateSecret", input);
			return succeed(input.name);
		},
		previewImport: async (_deps, input) => {
			record("previewImport", input);
			return ok(importPreview);
		},
		importProject: (_deps, input) => {
			record("importProject", input);
			return succeed();
		},
		planSetup: async (_deps, input) => {
			record("planSetup", input);
			return nonePlan;
		},
		startDockerRuntime: (_deps, input) => {
			record("startDockerRuntime", input);
			return succeed();
		},
		...overrides,
	};
	return { ops, calls };
}

/** Test ports with the fakes exposed for assertions. */
export interface TestPorts extends ServerPorts {
	/** In-memory files. */
	readonly files: InMemoryFileStore;
	/** Scripted streams. */
	readonly streams: FakeContainerStreams;
	/** Scripted folder picker. */
	readonly folderPicker: FakeFolderPicker;
	/** Scripted port probe. */
	readonly probe: FakePortProbe;
	/** Scripted docker exec. */
	readonly exec: FakeContainerExec;
	/** Scripted volume archiver. */
	readonly archiver: FakeVolumeArchiver;
	/** In-memory snapshot index (holds {@link snapshotRecord}). */
	readonly snapshots: FakeSnapshotIndex;
	/** In-memory operation history. */
	readonly journal: InMemoryOpJournal;
	/** Scripted machine facts (Docker Desktop installed and running, CLI on PATH). */
	readonly platform: FakePlatformInspector;
	/** Recording process runner (never spawns). */
	readonly runner: FakeProcessRunner;
	/** Daemon waiter answering ready. */
	readonly waiter: FakeDaemonWaiter;
}

/**
 * @param busyPorts - Ports the probe reports as taken.
 * @returns Fake ports rooted at `/home/test` (`~/Developer` exists).
 */
export function createTestPorts(busyPorts: number[] = []): TestPorts {
	const files = new InMemoryFileStore();
	for (const dir of ["/", "/home", "/home/test", "/home/test/Developer"])
		files.dirs.add(dir);
	return {
		state: new InMemoryStateStore(createEmptyState()),
		files,
		secrets: new InMemorySecretStore(),
		paths: createTestPaths(),
		catalog: new StaticCatalogSource([postgresDefinition]),
		probe: new FakePortProbe(busyPorts),
		gen: new SequentialSecretGenerator(),
		clock: new FixedClock("2026-09-23T08:00:00.000Z"),
		lifecycle: new FakeLifecycleRunner(),
		compose: new FakeComposeInfo(),
		docker: new FakeDockerInfo(),
		socket: new FakeSocketLocator(),
		containers: new FakeContainerReader(),
		inspector: new FakeContainerInspector(),
		streams: new FakeContainerStreams(),
		folderPicker: new FakeFolderPicker("/home/test/Developer/shop-api"),
		exec: new FakeContainerExec(),
		archiver: new FakeVolumeArchiver(),
		snapshots: new FakeSnapshotIndex([snapshotRecord]),
		journal: new InMemoryOpJournal(),
		platform: new FakePlatformInspector(
			createPlatformFacts({
				installedRuntimes: ["docker-desktop"],
				runningRuntime: "docker-desktop",
				dockerCliPath: "/usr/local/bin/docker",
			}),
		),
		runner: new FakeProcessRunner(),
		waiter: new FakeDaemonWaiter(),
	};
}

/**
 * @param overrides - Extra deps (ops, ports, timings).
 * @returns Server deps over the stubs, token {@link TOKEN}, host {@link HOST}.
 */
export function createTestDeps(
	overrides: Partial<ServerDeps> = {},
): ServerDeps & { calls: OpCall[]; ports: TestPorts } {
	const { ops, calls } = createStubOps();
	const ports = createTestPorts();
	return {
		token: TOKEN,
		allowedHosts: [HOST],
		ops,
		ports,
		docs: true,
		version: "0.1.0",
		calls,
		...overrides,
	} as ServerDeps & { calls: OpCall[]; ports: TestPorts };
}
