import { join } from "node:path";
import type { DirectoryLister, FileStore } from "../ports/files.port";
import type { CatalogError, ServiceDefinition } from "./catalog.model";
import type { CatalogSource } from "./catalog.source";
import { loadServiceDefinition } from "./loader";
import type { SafetyOptions } from "./validator";

/** Options of {@link DirectoryCatalogSource}. */
export interface DirectoryCatalogSourceOptions extends SafetyOptions {
	/** File access. */
	readonly files: FileStore;
	/** Directory listing. */
	readonly lister: DirectoryLister;
	/** Directory of `*.yaml` / `*.yml` definitions (e.g. `~/.locastack/catalog`). */
	readonly dir: string;
	/**
	 * Called for each invalid file, which is then skipped. When omitted, the
	 * first invalid file makes `definitions()` reject with its `CatalogError`.
	 */
	readonly onInvalid?: (error: CatalogError) => void;
}

/**
 * Loads every `*.yaml` / `*.yml` definition in a directory (user overrides or
 * the registry cache), in file-name order. Files are untrusted and go through
 * the full safety validation. File names must match the definition `id`.
 */
export class DirectoryCatalogSource implements CatalogSource {
	readonly #options: DirectoryCatalogSourceOptions;

	/** @param options - Files, lister, directory and error policy. */
	constructor(options: DirectoryCatalogSourceOptions) {
		this.#options = options;
	}

	/** @returns Valid definitions found in the directory. */
	async definitions(): Promise<ServiceDefinition[]> {
		const { files, lister, dir, onInvalid, allowedRegistries } = this.#options;
		const names = (await lister.list(dir))
			.filter((name) => /\.ya?ml$/.test(name) && !name.startsWith("."))
			.sort();
		const results = await Promise.all(
			names.map((name) =>
				loadServiceDefinition(files, join(dir, name), {
					expectedId: name.replace(/\.ya?ml$/, ""),
					allowedRegistries,
				}),
			),
		);
		const definitions: ServiceDefinition[] = [];
		for (const result of results) {
			if (result.ok) {
				definitions.push(result.value);
			} else if (onInvalid) {
				onInvalid(result.error);
			} else {
				throw result.error;
			}
		}
		return definitions;
	}
}
