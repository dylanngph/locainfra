import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addService,
	type CatalogError,
	type CatalogSource,
	catalogList,
	createCatalogSource,
	createProject,
	createSnapshot,
	dashboardFilePath,
	deleteSnapshot,
	discoverStack,
	downProject,
	downStack,
	envForStack,
	envPreview,
	getConnection,
	getService,
	getSystemInfo,
	importProject,
	linkEnv,
	listDataObjects,
	listProjects,
	listSnapshots,
	loadProject,
	planSetup,
	previewImport,
	registerProject,
	removeService,
	restartService,
	restoreSnapshot,
	rotateSecret,
	runDoctor,
	runQuery,
	runSetupPlan,
	seedService,
	startDockerRuntime,
	startService,
	statusForProject,
	stopService,
	unregisterProject,
	updateService,
	upProject,
	upStack,
} from "@locastack/core";
import {
	createEngines,
	type Engines,
	resolveBuiltinCatalogDir,
	resolveDefaultPaths,
} from "@locastack/engines";
import type { ServerOps, ServerPorts } from "@locastack/server";
import { version } from "../package.json";
import type { CliDeps, DashboardLauncher } from "./cli.types";

/** Environment variable overriding the built dashboard folder. */
export const DASHBOARD_DIR_ENV = "LOCASTACK_DASHBOARD_DIR";

/** Extra `host:port` values the dashboard accepts (comma-separated), e.g. a Vite dev server. */
export const EXTRA_HOSTS_ENV = "LOCASTACK_EXTRA_HOSTS";

/**
 * Fixed session token for automation (e2e tests); a random one is generated
 * when unset. Must be at least {@link MIN_SESSION_TOKEN_LENGTH} characters.
 */
export const SESSION_TOKEN_ENV = "LOCASTACK_SESSION_TOKEN";

/** Shortest accepted {@link SESSION_TOKEN_ENV} value. */
export const MIN_SESSION_TOKEN_LENGTH = 16;

/** Hosts of the Vite dev server (`bun run dev` in the dashboard), accepted when no SPA is built. */
export const VITE_DEV_HOSTS = ["127.0.0.1:5173", "localhost:5173"] as const;

/** How many ports above the first candidate {@link DashboardLauncher.findFreePort} tries. */
export const DASHBOARD_PORT_SPAN = 100;

/** Environment as read by the composition root. */
export type CompositionEnv = Readonly<Record<string, string | undefined>>;

/** Overrides for {@link composeDeps} (tests and alternative entry points). */
export interface ComposeDepsOptions {
	/** Environment for `LOCASTACK_HOME` / `LOCASTACK_CATALOG_DIR` / `LOCASTACK_DASHBOARD_DIR` (default `process.env`). */
	readonly env?: CompositionEnv;
	/** Home directory (default `os.homedir()`). */
	readonly home?: string;
	/** Prebuilt adapters (default `createEngines(paths)`). */
	readonly engines?: Engines;
	/** Filesystem probe for the asset resolvers (default: `node:fs` `existsSync`). */
	readonly exists?: ExistsFn;
	/**
	 * Receives invalid registry/override catalog files, which are skipped.
	 * Defaults to a one-line warning on stderr (never stdout, so `--json` stays clean).
	 */
	readonly onInvalidCatalog?: (error: CatalogError) => void;
}

function warnInvalidCatalog(error: CatalogError): void {
	process.stderr.write(`warning: skipping ${error.message}\n`);
}

/** Synchronous existence check (injectable so tests can simulate `/$bunfs`). */
export type ExistsFn = (path: string) => boolean;

/**
 * Root of the folders embedded with `bun build --compile --asset <dir>`.
 * Bun 1.4.2 puts a folder under its basename (`--asset packages/dashboard/dist`
 * → `/$bunfs/root/dist`); the resolvers also accept the full relative path
 * (`/$bunfs/root/packages/dashboard/dist`) in case a Bun release preserves it.
 * Windows binaries use `B:\~BUN\root`.
 *
 * @param platform - Target platform (default `process.platform`).
 * @returns The embedded-files root of a compiled binary.
 */
export function embeddedRoot(
	platform: NodeJS.Platform = process.platform,
): string {
	return platform === "win32" ? "B:\\~BUN\\root" : "/$bunfs/root";
}

/**
 * Where a `--asset <relativeDir>` folder may sit in the compiled binary: the
 * full relative path first, then its basename (what Bun 1.4.2 does).
 */
function embeddedCandidates(relativeDir: string): string[] {
	const segments = relativeDir.split("/");
	const full = join(embeddedRoot(), ...segments);
	const base = join(embeddedRoot(), segments.at(-1) ?? relativeDir);
	return full === base ? [full] : [full, base];
}

/**
 * Directory of the built-in catalog, read in place by the catalog loader:
 * `$LOCASTACK_CATALOG_DIR` (resolved against the cwd), else the compiled
 * binary's embedded `/$bunfs/root/catalog` when it exists, else the repo
 * `catalog/`. Nothing is copied: the loader lists `/$bunfs` through `node:fs`.
 *
 * @param env - Environment.
 * @param exists - Filesystem probe (default `existsSync`).
 * @returns Directory path.
 */
export function resolveCatalogDir(
	env: CompositionEnv,
	exists: ExistsFn = existsSync,
): string {
	const embedded = embeddedCandidates("catalog").find((dir) => exists(dir));
	return resolveBuiltinCatalogDir({
		env,
		...(embedded === undefined ? {} : { embeddedDir: embedded }),
	}).dir;
}

/** The dashboard package's Vite output in a source checkout. */
export function repoDashboardDir(): string {
	return fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
}

/**
 * Picks the built SPA folder to serve: `$LOCASTACK_DASHBOARD_DIR`, else the
 * compiled binary's embedded copy (`/$bunfs/root/dist`, see
 * {@link embeddedRoot}) when it has an `index.html`, else `packages/dashboard/dist` when built, else `undefined`
 * (development: the Vite dev server serves the SPA).
 *
 * @param env - Environment.
 * @param exists - Filesystem probe (default `existsSync`).
 * @returns The folder, or `undefined` when there is no built SPA.
 */
export function resolveDashboardAssets(
	env: CompositionEnv,
	exists: ExistsFn = existsSync,
): string | undefined {
	const override = env[DASHBOARD_DIR_ENV]?.trim();
	if (override) return override;
	const embedded = embeddedCandidates("packages/dashboard/dist").find((dir) =>
		exists(join(dir, "index.html")),
	);
	if (embedded !== undefined) return embedded;
	const repo = repoDashboardDir();
	return exists(join(repo, "index.html")) ? repo : undefined;
}

/**
 * Every core op the dashboard server calls.
 *
 * @returns The op table.
 */
export function serverOps(): ServerOps {
	return {
		runDoctor,
		getSystemInfo,
		planSetup,
		startDockerRuntime,
		catalogList,
		listProjects,
		registerProject,
		createProject,
		unregisterProject,
		loadProject,
		upProject,
		downProject,
		statusForProject,
		getService,
		addService,
		removeService,
		updateService,
		startService,
		stopService,
		restartService,
		envPreview,
		linkEnv,
		getConnection,
		listDataObjects,
		runQuery,
		listSnapshots,
		createSnapshot,
		restoreSnapshot,
		deleteSnapshot,
		seedService,
		rotateSecret,
		previewImport,
		importProject,
	};
}

/**
 * The server's ports: engine adapters plus the merged catalog.
 *
 * @param engines - Adapters.
 * @param catalog - Merged catalog.
 * @returns The port bundle every server op and the observer receive.
 */
export function serverPorts(
	engines: Engines,
	catalog: CatalogSource,
): ServerPorts {
	return {
		state: engines.state,
		files: engines.files,
		secrets: engines.secrets,
		paths: engines.paths,
		catalog,
		probe: engines.probe,
		gen: engines.gen,
		clock: engines.clock,
		lifecycle: engines.lifecycle,
		compose: engines.compose,
		docker: engines.docker,
		socket: engines.socket,
		containers: engines.containers,
		inspector: engines.inspector,
		streams: engines.streams,
		folderPicker: engines.folderPicker,
		exec: engines.exec,
		archiver: engines.archiver,
		snapshots: engines.snapshots,
		journal: engines.journal,
		platform: engines.platform,
		runner: engines.runner,
		waiter: engines.waiter,
	};
}

/** Inputs of {@link createDashboardLauncher}. */
export interface DashboardLauncherOptions {
	/** Adapters. */
	readonly engines: Engines;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
	/** Built SPA folder; `undefined` in development (Vite serves it). */
	readonly staticDir?: string | undefined;
	/** Environment (extra hosts). */
	readonly env: CompositionEnv;
}

/**
 * The real {@link DashboardLauncher}. `@locastack/server` (Elysia) is
 * imported only when bare `locastack` actually probes or starts a server, so
 * `up`/`down`/`env`/`doctor` never load it.
 *
 * @param options - Adapters, catalog, SPA source and environment.
 * @returns The launcher.
 */
export function createDashboardLauncher(
	options: DashboardLauncherOptions,
): DashboardLauncher {
	const { engines, catalog, staticDir, env } = options;
	const file = dashboardFilePath(engines.paths);
	const extraHosts = [
		...(env[EXTRA_HOSTS_ENV]
			?.split(",")
			.map((h) => h.trim())
			.filter(Boolean) ?? []),
		...(staticDir === undefined ? VITE_DEV_HOSTS : []),
	];
	return {
		async findRunning() {
			const { probeDashboard } = await import("@locastack/server");
			const running = await probeDashboard(file);
			return running === null
				? null
				: { pid: running.pid, port: running.port, url: running.url };
		},
		async findFreePort(from) {
			for (let port = from; port < from + DASHBOARD_PORT_SPAN; port += 1) {
				if (port > 65535) return undefined;
				if (await engines.probe.isFree(port)) return port;
			}
			return undefined;
		},
		createToken: () => {
			const fixed = env[SESSION_TOKEN_ENV]?.trim();
			return fixed && fixed.length >= MIN_SESSION_TOKEN_LENGTH
				? fixed
				: randomBytes(24).toString("base64url");
		},
		async start({ port, token }) {
			const { startServer } = await import("@locastack/server");
			const server = await startServer({
				port,
				token,
				deps: {
					ops: serverOps(),
					ports: serverPorts(engines, catalog),
					version,
				},
				...(staticDir === undefined ? {} : { staticDir }),
				extraHosts,
				dashboardFile: file,
				handleSignals: false,
			});
			return {
				port: server.port,
				url: server.url,
				servesSpa: staticDir !== undefined,
				stop: () => server.stop(),
			};
		},
		openBrowser: (url) => engines.browser.open(url),
		waitForShutdown: () =>
			new Promise<void>((resolve) => {
				const done = () => {
					process.off("SIGINT", done);
					process.off("SIGTERM", done);
					resolve();
				};
				process.once("SIGINT", done);
				process.once("SIGTERM", done);
			}),
	};
}

/**
 * The CLI's single composition root: resolves `Paths`, builds the
 * engines and the merged catalog (built-ins → registry cache → user
 * overrides), and hands each op exactly the ports its contract declares.
 * Cheap: nothing touches Docker or starts a server until a command runs.
 *
 * @param options - Environment, home, adapter and filesystem-probe overrides.
 * @returns Ops plus their dependency bundles.
 */
export function composeDeps(options: ComposeDepsOptions = {}): CliDeps {
	const env = options.env ?? process.env;
	const paths = resolveDefaultPaths(
		options.home === undefined ? { env } : { env, home: options.home },
	);
	const engines = options.engines ?? createEngines(paths);
	const exists = options.exists ?? existsSync;
	const catalog = createCatalogSource({
		files: engines.files,
		catalogDir: resolveCatalogDir(env, exists),
		lister: engines.files,
		overrideDirs: [paths.registryDir, paths.catalogOverridesDir],
		onInvalid: options.onInvalidCatalog ?? warnInvalidCatalog,
	});
	const doctor = {
		docker: engines.docker,
		compose: engines.compose,
		socket: engines.socket,
		clock: engines.clock,
		platform: engines.platform,
	};
	return {
		ops: {
			runDoctor,
			upStack,
			downStack,
			envForStack,
			discoverStack,
			registerProject,
			createProject,
			planSetup,
			runSetupPlan,
		},
		doctor,
		setup: {
			platform: engines.platform,
			runner: engines.runner,
			waiter: engines.waiter,
			doctor,
		},
		up: {
			files: engines.files,
			state: engines.state,
			secrets: engines.secrets,
			probe: engines.probe,
			gen: engines.gen,
			lifecycle: engines.lifecycle,
			compose: engines.compose,
			paths,
			clock: engines.clock,
			catalog,
		},
		down: {
			lifecycle: engines.lifecycle,
			paths,
			state: engines.state,
			files: engines.files,
		},
		env: {
			files: engines.files,
			state: engines.state,
			secrets: engines.secrets,
			paths,
			catalog,
		},
		discover: { files: engines.files },
		projects: { files: engines.files, state: engines.state },
		dashboard: createDashboardLauncher({
			engines,
			catalog,
			staticDir: resolveDashboardAssets(env, exists),
			env,
		}),
	};
}
