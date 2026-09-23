import { join } from "node:path";
import type { FileStore } from "../ports/files.port";
import type { ServiceDefinition } from "./catalog.model";
import type { CatalogSource } from "./catalog.source";
import { loadServiceDefinition } from "./loader";

/**
 * File names of the built-in definitions shipped in the repo-root `catalog/`
 * folder. Listed explicitly (instead of scanning the directory) so the same
 * code works from source and from the `--asset`-embedded folder of a compiled
 * binary, where directory listing is unavailable.
 */
export const BUILTIN_CATALOG_FILES: readonly string[] = [
	"postgres.yaml",
	"redis.yaml",
	"upstash-redis.yaml",
];

/**
 * Loads the built-in definitions from `catalogDir` through a {@link FileStore}.
 *
 * The composition root passes the directory: the repo-root `catalog/` in
 * development, or the embedded asset path in a compiled binary. Built-ins are
 * part of the release, so any invalid or missing file is a packaging bug and
 * makes {@link BuiltinCatalogSource.definitions} reject with a `CatalogError`.
 * Results are cached after the first successful load.
 */
export class BuiltinCatalogSource implements CatalogSource {
	readonly #files: FileStore;
	readonly #catalogDir: string;
	readonly #fileNames: readonly string[];
	#cache: Promise<ServiceDefinition[]> | undefined;

	/**
	 * @param files - File access.
	 * @param catalogDir - Absolute directory holding the built-in YAML files.
	 * @param fileNames - Files to load (default {@link BUILTIN_CATALOG_FILES}).
	 */
	constructor(
		files: FileStore,
		catalogDir: string,
		fileNames: readonly string[] = BUILTIN_CATALOG_FILES,
	) {
		this.#files = files;
		this.#catalogDir = catalogDir;
		this.#fileNames = fileNames;
	}

	/** @returns The built-in definitions, in {@link BUILTIN_CATALOG_FILES} order. */
	definitions(): Promise<ServiceDefinition[]> {
		if (this.#cache === undefined) {
			const load = this.#load();
			this.#cache = load;
			load.catch(() => {
				this.#cache = undefined;
			});
		}
		return this.#cache.then((definitions) => [...definitions]);
	}

	async #load(): Promise<ServiceDefinition[]> {
		const results = await Promise.all(
			this.#fileNames.map((fileName) =>
				loadServiceDefinition(this.#files, join(this.#catalogDir, fileName), {
					expectedId: fileName.replace(/\.ya?ml$/, ""),
				}),
			),
		);
		return results.map((result) => {
			if (!result.ok) throw result.error;
			return result.value;
		});
	}
}
