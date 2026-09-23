import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	OpError,
	type Paths,
	type SecretStore,
	secretsFilePath,
} from "@locainfra/core";
import { readTextIfExists } from "../fs/read-text";
import { writeFileAtomic } from "./atomic-write";
import { acquireFileLock, type FileLockOptions } from "./file-lock";

const STACK_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE_VALUE = /^[A-Za-z0-9_\-.:@/+=%,]*$/;
const HEADER =
	"# Managed by LocaInfra. Contains secrets: do not commit or share.\n";

/**
 * Serialises secrets as a dotenv file. Values are written bare when safe,
 * single-quoted (literal) when possible, otherwise double-quoted with escapes.
 *
 * @param secrets - Key → value.
 * @returns File content.
 * @throws {OpError} `IO` for a key that is not a valid env name.
 */
export function formatSecretsEnv(
	secrets: Readonly<Record<string, string>>,
): string {
	const lines = Object.keys(secrets)
		.sort()
		.map((key) => {
			if (!ENV_KEY.test(key)) {
				throw new OpError("IO", `Invalid secret name: ${key}`);
			}
			return `${key}=${quoteValue(secrets[key] ?? "")}`;
		});
	return `${HEADER}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

function quoteValue(value: string): string {
	if (BARE_VALUE.test(value)) return value;
	if (!/['\n\r]/.test(value)) return `'${value}'`;
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r");
	return `"${escaped}"`;
}

function unescapeDouble(value: string): string {
	return value.replace(/\\([\\"nr])/g, (_, ch: string) => {
		if (ch === "n") return "\n";
		if (ch === "r") return "\r";
		return ch;
	});
}

/**
 * Parses a dotenv file written by {@link formatSecretsEnv} (comments, blank lines,
 * bare, single- and double-quoted values; optional `export ` prefix).
 *
 * @param content - File content.
 * @returns Key → value.
 */
export function parseSecretsEnv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
			line,
		);
		if (match === null) continue;
		const key = match[1] ?? "";
		const value = match[2] ?? "";
		if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
			out[key] = value.slice(1, -1);
		} else if (
			value.length >= 2 &&
			value.startsWith('"') &&
			value.endsWith('"')
		) {
			out[key] = unescapeDouble(value.slice(1, -1));
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Options for {@link FileSecretStore}. */
export interface FileSecretStoreOptions {
	/** Timing of the per-stack `<stack>.env.lock` taken by `update`. */
	readonly lock?: FileLockOptions;
}

/**
 * {@link SecretStore} over `<paths.secretsDir>/<stack>.env`, mode 0600 (directory 0700).
 * Writes are atomic; `update` holds `<stack>.env.lock` across its
 * read-modify-write. Values are never logged or included in error messages.
 */
export class FileSecretStore implements SecretStore {
	readonly #paths: Paths;
	readonly #lockOptions: FileLockOptions;

	/**
	 * @param paths - Filesystem layout (uses `secretsDir`).
	 * @param options - Lock timing.
	 */
	constructor(paths: Paths, options: FileSecretStoreOptions = {}) {
		this.#paths = paths;
		this.#lockOptions = options.lock ?? {};
	}

	/**
	 * @param stack - Stack name.
	 * @returns The stack's secrets, or `{}` when none are stored.
	 * @throws {OpError} `IO` for an invalid stack name.
	 */
	async read(stack: string): Promise<Record<string, string>> {
		const text = await readTextIfExists(this.#pathFor(stack));
		return text === null ? {} : parseSecretsEnv(text);
	}

	/**
	 * Replaces the stack's secrets file atomically with mode 0600.
	 *
	 * @param stack - Stack name.
	 * @param secrets - Complete secret map.
	 * @throws {OpError} `IO` for an invalid stack or secret name.
	 */
	async write(stack: string, secrets: Record<string, string>): Promise<void> {
		const path = this.#pathFor(stack);
		await writeFileAtomic(path, formatSecretsEnv(secrets), {
			mode: 0o600,
			dirMode: 0o700,
		});
		await chmod(path, 0o600);
	}

	/**
	 * Locked read-modify-write of the stack's secrets: concurrent callers (in
	 * this or another process) are serialised on `<stack>.env.lock`, so each
	 * sees the previous caller's values.
	 *
	 * @param stack - Stack name.
	 * @param mutate - Current secrets → complete new map, or `undefined` for no change.
	 * @returns The stack's secrets after the update.
	 * @throws {OpError} `IO` for an invalid stack or secret name, or a lock timeout.
	 */
	async update(
		stack: string,
		mutate: (
			current: Record<string, string>,
		) => Record<string, string> | undefined,
	): Promise<Record<string, string>> {
		const path = this.#pathFor(stack);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const release = await acquireFileLock(`${path}.lock`, this.#lockOptions);
		try {
			const current = await this.read(stack);
			const next = mutate({ ...current });
			if (next === undefined) return current;
			await this.write(stack, next);
			return { ...next };
		} finally {
			await release();
		}
	}

	#pathFor(stack: string): string {
		if (!STACK_NAME.test(stack)) {
			throw new OpError("IO", `Invalid stack name: ${stack}`);
		}
		return secretsFilePath(this.#paths, stack);
	}
}
