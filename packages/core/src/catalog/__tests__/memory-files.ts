import type { DirectoryLister, FileStore } from "../../ports/files.port";

/** In-memory FileStore + DirectoryLister for catalog tests. */
export class MemoryFiles implements FileStore, DirectoryLister {
	readonly store = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [path, text] of Object.entries(initial))
			this.store.set(path, text);
	}

	async readText(path: string): Promise<string | null> {
		return this.store.get(path) ?? null;
	}

	async writeText(path: string, content: string): Promise<void> {
		this.store.set(path, content);
	}

	async exists(path: string): Promise<boolean> {
		if (this.store.has(path)) return true;
		const prefix = path.endsWith("/") ? path : `${path}/`;
		return [...this.store.keys()].some((key) => key.startsWith(prefix));
	}

	async mkdirp(): Promise<void> {}

	async list(dir: string): Promise<string[]> {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		return [...this.store.keys()]
			.filter(
				(key) =>
					key.startsWith(prefix) && !key.slice(prefix.length).includes("/"),
			)
			.map((key) => key.slice(prefix.length));
	}
}

/** Read-only FileStore over the real disk (tests only). */
export const diskFiles: FileStore = {
	async readText(path) {
		const file = Bun.file(path);
		return (await file.exists()) ? file.text() : null;
	},
	async writeText() {
		throw new Error("read-only");
	},
	async exists(path) {
		return Bun.file(path).exists();
	},
	async mkdirp() {},
};
