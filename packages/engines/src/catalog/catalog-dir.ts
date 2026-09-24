import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variable overriding the built-in catalog directory. */
export const CATALOG_DIR_ENV = "LOCASTACK_CATALOG_DIR";

/** Inputs of {@link resolveBuiltinCatalogDir}. */
export interface BuiltinCatalogDirOptions {
	/** Environment (default `process.env`); `LOCASTACK_CATALOG_DIR` wins when set. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Directory holding the catalog `*.yaml` files shipped inside a compiled
	 * binary. The CLI composition root owns this: the build embeds the folder
	 * with `bun build --compile --asset catalog` and the loader reads it in
	 * place (`/$bunfs/root/catalog`, listed through `node:fs`). Omit when
	 * running from source.
	 */
	readonly embeddedDir?: string;
}

/** Where {@link resolveBuiltinCatalogDir} found the catalog. */
export type BuiltinCatalogSource = "env" | "embedded" | "repo";

/** Result of {@link resolveBuiltinCatalogDir}. */
export interface BuiltinCatalogDir {
	/** Absolute directory of the built-in `*.yaml` definitions. */
	readonly dir: string;
	/** Which rule chose it. */
	readonly source: BuiltinCatalogSource;
}

/**
 * The repo's `catalog/` folder, resolved relative to this source file
 * (`packages/engines/src/catalog` → `../../../../catalog`). Only meaningful
 * when running from source; inside a compiled binary this points into Bun's
 * virtual filesystem, which is why the CLI passes `embeddedDir` there.
 *
 * @returns Absolute path of the repo catalog folder.
 */
export function repoCatalogDir(): string {
	return fileURLToPath(new URL("../../../../catalog", import.meta.url));
}

/**
 * Chooses the built-in catalog directory, in order:
 * 1. `$LOCASTACK_CATALOG_DIR` (trimmed, resolved against the cwd) when non-empty;
 * 2. `options.embeddedDir` when non-empty (compiled binary; see its docs);
 * 3. the repo `catalog/` folder ({@link repoCatalogDir}).
 *
 * Pure: it does not check that the folder exists; the catalog loader reports that.
 *
 * @param options - Environment and embedded assets folder.
 * @returns The directory and the rule that chose it.
 */
export function resolveBuiltinCatalogDir(
	options: BuiltinCatalogDirOptions = {},
): BuiltinCatalogDir {
	const env = options.env ?? process.env;
	const override = env[CATALOG_DIR_ENV]?.trim();
	if (override) return { dir: resolve(override), source: "env" };
	const embedded = options.embeddedDir?.trim();
	if (embedded) return { dir: resolve(embedded), source: "embedded" };
	return { dir: repoCatalogDir(), source: "repo" };
}
