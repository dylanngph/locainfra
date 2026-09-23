import type { DirectoryLister, FileStore } from "../ports/files.port";
import { BuiltinCatalogSource } from "./builtin";
import type { CatalogError, ServiceDefinition } from "./catalog.model";
import type { CatalogSource } from "./catalog.source";
import { DirectoryCatalogSource } from "./directory.source";
import type { SafetyOptions } from "./validator";

/**
 * Merges definition layers by `id`: a later layer replaces an earlier
 * definition in place, so the order of first appearance is kept.
 *
 * @param layers - Definition lists, lowest precedence first.
 * @returns One definition per id.
 */
export function mergeDefinitions(
	layers: ReadonlyArray<readonly ServiceDefinition[]>,
): ServiceDefinition[] {
	const merged = new Map<string, ServiceDefinition>();
	for (const layer of layers) {
		for (const definition of layer) merged.set(definition.id, definition);
	}
	return [...merged.values()];
}

/**
 * A {@link CatalogSource} stacking other sources; later sources win by `id`
 * (built-ins → registry cache → user overrides).
 */
export class CompositeCatalogSource implements CatalogSource {
	readonly #sources: readonly CatalogSource[];

	/** @param sources - Sources, lowest precedence first. */
	constructor(sources: readonly CatalogSource[]) {
		this.#sources = sources;
	}

	/** @returns The merged catalog. Rejects if any source rejects. */
	async definitions(): Promise<ServiceDefinition[]> {
		const layers = await Promise.all(
			this.#sources.map((source) => source.definitions()),
		);
		return mergeDefinitions(layers);
	}
}

/** Options of {@link createCatalogSource}. */
export interface CreateCatalogSourceOptions extends SafetyOptions {
	/** File access. */
	readonly files: FileStore;
	/** Directory of the built-in YAML files (repo `catalog/` or embedded asset dir). */
	readonly catalogDir: string;
	/** Directory listing for the override directories. */
	readonly lister?: DirectoryLister;
	/**
	 * Override directories, lowest precedence first, e.g.
	 * `[paths.registryDir, paths.catalogOverridesDir]`. Ignored without `lister`.
	 */
	readonly overrideDirs?: readonly string[];
	/** Invalid override files are reported here and skipped (built-ins always throw). */
	readonly onInvalid?: (error: CatalogError) => void;
}

/**
 * Builds the standard catalog: built-ins, then each override directory.
 *
 * @param options - Files, directories and error policy.
 * @returns A composite source.
 */
export function createCatalogSource(
	options: CreateCatalogSourceOptions,
): CatalogSource {
	const { files, catalogDir, lister, overrideDirs = [], onInvalid } = options;
	const sources: CatalogSource[] = [
		new BuiltinCatalogSource(files, catalogDir),
	];
	if (lister) {
		for (const dir of overrideDirs) {
			sources.push(
				new DirectoryCatalogSource({
					files,
					lister,
					dir,
					onInvalid,
					allowedRegistries: options.allowedRegistries,
				}),
			);
		}
	}
	return new CompositeCatalogSource(sources);
}
