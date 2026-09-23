import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CatalogError,
	createCatalogSource,
	discoverStack,
	downStack,
	envForStack,
	runDoctor,
	upStack,
} from "@locainfra/core";
import {
	createEngines,
	type Engines,
	resolveDefaultPaths,
} from "@locainfra/engines";
import type { CliDeps } from "./cli.types";

/** Environment variable overriding the built-in catalog directory. */
export const CATALOG_DIR_ENV = "LOCAINFRA_CATALOG_DIR";

/** Environment as read by the composition root. */
export type CompositionEnv = Readonly<Record<string, string | undefined>>;

/**
 * Directory holding the built-in `*.yaml` definitions: `$LOCAINFRA_CATALOG_DIR`
 * when set, otherwise the repo-root `catalog/` resolved relative to this file
 * (`packages/cli/src` → `../../../catalog`).
 *
 * TODO(M2, plan §5): in a compiled binary, point at the `--asset`-embedded
 * catalog instead of the source tree.
 *
 * @param env - Environment (default `process.env`).
 * @returns Absolute directory path.
 */
export function resolveCatalogDir(env: CompositionEnv = process.env): string {
	const override = env[CATALOG_DIR_ENV]?.trim();
	if (override) return resolve(override);
	return fileURLToPath(new URL("../../../catalog", import.meta.url));
}

/** Overrides for {@link composeDeps} (tests and alternative entry points). */
export interface ComposeDepsOptions {
	/** Environment for `LOCAINFRA_HOME` / `LOCAINFRA_CATALOG_DIR` (default `process.env`). */
	readonly env?: CompositionEnv;
	/** Home directory (default `os.homedir()`). */
	readonly home?: string;
	/** Prebuilt adapters (default `createEngines(paths)`). */
	readonly engines?: Engines;
	/**
	 * Receives invalid registry/override catalog files, which are skipped.
	 * Defaults to a one-line warning on stderr (never stdout, so `--json` stays clean).
	 */
	readonly onInvalidCatalog?: (error: CatalogError) => void;
}

function warnInvalidCatalog(error: CatalogError): void {
	process.stderr.write(`warning: skipping ${error.message}\n`);
}

/**
 * The CLI's single composition root: resolves `Paths`, builds the
 * engines and the merged catalog (built-ins → registry cache → user
 * overrides), and hands each op exactly the ports its contract declares.
 * Cheap and side-effect free; nothing touches Docker until an op runs.
 *
 * @param options - Environment, home and adapter overrides.
 * @returns Ops plus their dependency bundles.
 */
export function composeDeps(options: ComposeDepsOptions = {}): CliDeps {
	const env = options.env ?? process.env;
	const paths = resolveDefaultPaths(
		options.home === undefined ? { env } : { env, home: options.home },
	);
	const engines = options.engines ?? createEngines(paths);
	const catalog = createCatalogSource({
		files: engines.files,
		catalogDir: resolveCatalogDir(env),
		lister: engines.files,
		overrideDirs: [paths.registryDir, paths.catalogOverridesDir],
		onInvalid: options.onInvalidCatalog ?? warnInvalidCatalog,
	});
	return {
		ops: { runDoctor, upStack, downStack, envForStack, discoverStack },
		doctor: {
			docker: engines.docker,
			compose: engines.compose,
			socket: engines.socket,
			clock: engines.clock,
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
		discover: { files: engines.files, paths },
	};
}
