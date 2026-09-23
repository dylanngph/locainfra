import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
 * In-process queue per lock path. Waiters in one process take turns before
 * touching the filesystem, so they never race each other through
 * {@link takeOver} (whose rename-and-restore window could otherwise let two
 * same-process waiters both believe they hold the lock).
 */
const localQueues = new Map<string, Promise<void>>();

/**
 * Joins the in-process queue for `key`.
 *
 * @returns `ready` settles when every earlier same-process waiter has
 *   released; `leave` must be called exactly once when this waiter is done
 *   (after release, or after giving up).
 */
function joinLocalQueue(key: string): {
	ready: Promise<void>;
	leave: () => void;
} {
	const previous = localQueues.get(key) ?? Promise.resolve();
	let leave: () => void = () => undefined;
	const mine = new Promise<void>((done) => {
		leave = done;
	});
	const tail = previous.then(() => mine);
	localQueues.set(key, tail);
	void tail.then(() => {
		if (localQueues.get(key) === tail) localQueues.delete(key);
	});
	let left = false;
	return {
		ready: previous,
		leave: () => {
			if (left) return;
			left = true;
			// Hand over only after every predecessor is done, so the chain stays ordered.
			void previous.then(leave);
		},
	};
}

/** Resolves `promise`, or `false` once `ms` elapse first. */
async function within(promise: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((done) => {
		timer = setTimeout(() => done(false), Math.max(0, ms));
	});
	try {
		return await Promise.race([promise.then(() => true as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function lockTimeout(
	lockPath: string,
	timeoutMs: number,
): Promise<OpError> {
	const holder = await readOwner(lockPath).catch(() => null);
	return new OpError("IO", `Timed out waiting for lock ${lockPath}`, {
		details: {
			lockPath,
			timeoutMs,
			...(holder ? { holderPid: holder.pid } : {}),
			fix: `Another LocaInfra process holds the lock. If none is running, delete ${lockPath}.`,
		},
	});
}

/**
 * Acquires an exclusive lock by atomically creating `lockPath` with an owner
 * record (pid plus a random token), retrying until the timeout. An abandoned
 * lock (its process is gone) is taken over atomically; a live holder's lock
 * never is. Release removes the lock only while it still carries this
 * acquisition's token, so it can never delete another process's lock.
 * Waiters within one process queue in memory first, so only one of them
 * competes on the filesystem at a time.
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
	const queue = joinLocalQueue(resolve(lockPath));
	try {
		if (!(await within(queue.ready, deadline - Date.now()))) {
			throw await lockTimeout(lockPath, timeoutMs);
		}
		for (;;) {
			if (await tryCreate(lockPath, owner)) {
				let released = false;
				return async () => {
					if (released) return;
					released = true;
					try {
						await releaseIfOwned(lockPath, owner);
					} finally {
						queue.leave();
					}
				};
			}
			if (await isAbandoned(lockPath, staleMs)) {
				await takeOver(lockPath, staleMs);
				continue;
			}
			if (Date.now() >= deadline) throw await lockTimeout(lockPath, timeoutMs);
			await Bun.sleep(retryDelayMs);
		}
	} catch (error) {
		queue.leave();
		throw error;
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
