import type {
	DirectoryLister,
	FileInfo,
	FileStore,
} from "../../ports/files.port";

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

	async isDirectory(path: string): Promise<boolean> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		return [...this.store.keys()].some((key) => key.startsWith(prefix));
	}

	async mkdirp(): Promise<void> {}

	async fileInfo(path: string): Promise<FileInfo | null> {
		const text = this.store.get(path);
		if (text !== undefined) {
			return {
				realPath: path,
				kind: "file",
				sizeBytes: Buffer.byteLength(text, "utf8"),
			};
		}
		return (await this.isDirectory(path))
			? { realPath: path, kind: "directory", sizeBytes: 0 }
			: null;
	}

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
	async isDirectory(path) {
		try {
			return (await Bun.file(path).stat()).isDirectory();
		} catch {
			return false;
		}
	},
	async mkdirp() {},
	async fileInfo(path) {
		try {
			const info = await Bun.file(path).stat();
			return {
				realPath: path,
				kind: info.isFile()
					? "file"
					: info.isDirectory()
						? "directory"
						: "other",
				sizeBytes: info.size,
			};
		} catch {
			return null;
		}
	},
};
