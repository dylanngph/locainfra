import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { OpError } from "@locainfra/core";

/** Options for {@link acquireFileLock}. */
export interface FileLockOptions {
	/** Give up after this many milliseconds (default 5000). */
	readonly timeoutMs?: number;
	/** Delay between attempts in milliseconds (default 25). */
	readonly retryDelayMs?: number;
	/**
	 * A lock whose owner cannot be read (no pid in it) is considered abandoned
	 * once older than this (default 30000). A lock whose recorded process is
	 * alive is never taken over, however old; one whose process is gone is
	 * taken over at once.
	 */
	readonly staleMs?: number;
}

/** Releases a lock acquired by {@link acquireFileLock}. Idempotent. */
export type ReleaseLock = () => Promise<void>;

/** Owner record written into a lock file: `<pid>\n<token>\n`. */
interface LockOwner {
	readonly pid: number;
	readonly token: string;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function randomSuffix(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function parseOwner(text: string): LockOwner | null {
	const [pidText, token] = text.split("\n");
	const pid = Number(pidText);
	if (!Number.isInteger(pid) || pid <= 0 || !token) return null;
	return { pid, token };
}

async function readOwner(path: string): Promise<LockOwner | null | undefined> {
	try {
		return parseOwner(await readFile(path, "utf8"));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * @param pid - Process id.
 * @returns Whether a process with this id exists (`EPERM` means it exists but
 *   belongs to another user).
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/**
 * Creates `lockPath` atomically with its owner record already inside: the
 * record goes to a unique temp file that is hard-linked to `lockPath`
 * (`link` fails with `EEXIST` when the lock is held), so no reader ever sees
 * an empty lock file.
 *
 * @returns Whether the lock was created.
 */
async function tryCreate(lockPath: string, owner: LockOwner): Promise<boolean> {
	const temp = `${lockPath}.${owner.pid}.${randomSuffix()}.tmp`;
	await writeFile(temp, `${owner.pid}\n${owner.token}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	try {
		await link(temp, lockPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

/**
 * Whether the lock file at `path` is abandoned: its process is gone, or it
 * has no readable owner and is older than `staleMs`.
 */
async function isAbandoned(path: string, staleMs: number): Promise<boolean> {
	const owner = await readOwner(path);
	if (owner === undefined) return false;
	if (owner !== null) return !isProcessAlive(owner.pid);
	try {
		const info = await stat(path);
		return Date.now() - info.mtimeMs > staleMs;
	} catch {
		return false;
	}
}

/**
 * Removes an abandoned lock without racing other waiters. The lock is first
 * renamed to a unique name (only one waiter's rename can move a given file),
 * then the moved file itself is re-checked: if it turns out to be a live lock
 * that another waiter created in the meantime, it is linked back into place.
 */
async function takeOver(lockPath: string, staleMs: number): Promise<void> {
	const moved = `${lockPath}.${process.pid}.${randomSuffix()}.stale`;
	try {
		await rename(lockPath, moved);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	try {
		if (!(await isAbandoned(moved, staleMs))) {
			await link(moved, lockPath).catch((error: unknown) => {
				if (errorCode(error) !== "EEXIST") throw error;
			});
		}
	} finally {
		await rm(moved, { force: true });
	}
}

/**
 * Acquires an exclusive lock by atomically creating `lockPath` with an owner
 * record (pid plus a random token), retrying until the timeout. An abandoned
 * lock (its process is gone) is taken over atomically; a live holder's lock
 * never is. Release removes the lock only while it still carries this
 * acquisition's token, so it can never delete another process's lock.
 *
 * @param lockPath - Lock file path (e.g. `state.json.lock`).
 * @param options - Timing.
 * @returns A function that releases the lock.
 * @throws {OpError} `IO` when the lock cannot be acquired within the timeout.
 */
export async function acquireFileLock(
	lockPath: string,
	options: FileLockOptions = {},
): Promise<ReleaseLock> {
	const timeoutMs = options.timeoutMs ?? 5000;
	const retryDelayMs = options.retryDelayMs ?? 25;
	const staleMs = options.staleMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	const owner: LockOwner = { pid: process.pid, token: crypto.randomUUID() };
	for (;;) {
		if (await tryCreate(lockPath, owner)) {
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await releaseIfOwned(lockPath, owner);
			};
		}
		if (await isAbandoned(lockPath, staleMs)) {
			await takeOver(lockPath, staleMs);
			continue;
		}
		if (Date.now() >= deadline) {
			const holder = await readOwner(lockPath).catch(() => null);
			throw new OpError("IO", `Timed out waiting for lock ${lockPath}`, {
				details: {
					lockPath,
					timeoutMs,
					...(holder ? { holderPid: holder.pid } : {}),
					fix: `Another LocaInfra process holds the lock. If none is running, delete ${lockPath}.`,
				},
			});
		}
		await Bun.sleep(retryDelayMs);
	}
}

/** Removes `lockPath` only if it still carries `owner`'s token. */
async function releaseIfOwned(
	lockPath: string,
	owner: LockOwner,
): Promise<void> {
	const current = await readOwner(lockPath);
	if (current?.token !== owner.token) return;
	await rm(lockPath, { force: true });
}
