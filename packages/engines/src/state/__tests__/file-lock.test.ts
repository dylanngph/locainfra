import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, isProcessAlive } from "../file-lock";

let dir: string;
let lockPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ls-lock-"));
	lockPath = join(dir, "state.json.lock");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A pid that belonged to a process which has exited. */
async function deadPid(): Promise<number> {
	const child = Bun.spawn(["true"]);
	await child.exited;
	expect(isProcessAlive(child.pid)).toBe(false);
	return child.pid;
}

function age(path: string, ms: number): void {
	const then = new Date(Date.now() - ms);
	utimesSync(path, then, then);
}

describe("acquireFileLock", () => {
	test("writes pid and a token; release removes the lock and leaves no temp files", async () => {
		const release = await acquireFileLock(lockPath);
		const [pid, token] = readFileSync(lockPath, "utf8").split("\n");
		expect(Number(pid)).toBe(process.pid);
		expect(token).toMatch(/^[0-9a-f-]{36}$/);
		await release();
		await release();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("a live holder's lock is never taken over, however old", async () => {
		writeFileSync(lockPath, `${process.pid}\nsomeone-else\n`);
		age(lockPath, 10 * 60_000);
		const error = await acquireFileLock(lockPath, {
			timeoutMs: 80,
			retryDelayMs: 10,
			staleMs: 1,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(
			(error as { details?: { holderPid?: number } }).details?.holderPid,
		).toBe(process.pid);
		expect(readFileSync(lockPath, "utf8")).toBe(
			`${process.pid}\nsomeone-else\n`,
		);
	});

	test("a lock whose process is gone is taken over at once", async () => {
		writeFileSync(lockPath, `${await deadPid()}\nabandoned\n`);
		const started = Date.now();
		const release = await acquireFileLock(lockPath, {
			timeoutMs: 1000,
			staleMs: 60_000,
		});
		expect(Date.now() - started).toBeLessThan(500);
		expect(readFileSync(lockPath, "utf8")).toStartWith(`${process.pid}\n`);
		await release();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("release never deletes a lock that now belongs to someone else", async () => {
		const release = await acquireFileLock(lockPath);
		// The lock was taken over (e.g. declared stale) and re-created by another owner.
		writeFileSync(lockPath, "4242\nother-owner\n");
		await release();
		expect(existsSync(lockPath)).toBe(true);
		expect(readFileSync(lockPath, "utf8")).toBe("4242\nother-owner\n");
	});

	test("waiters racing to take over one abandoned lock never hold it together", async () => {
		writeFileSync(lockPath, `${await deadPid()}\nabandoned\n`);
		let active = 0;
		let maxActive = 0;
		let entered = 0;
		await Promise.all(
			Array.from({ length: 8 }, async () => {
				const release = await acquireFileLock(lockPath, {
					timeoutMs: 5000,
					retryDelayMs: 1,
				});
				active++;
				entered++;
				maxActive = Math.max(maxActive, active);
				await Bun.sleep(5);
				active--;
				await release();
			}),
		);
		expect(entered).toBe(8);
		expect(maxActive).toBe(1);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("an ownerless lock (legacy or corrupt) is abandoned only after staleMs", async () => {
		writeFileSync(lockPath, "");
		const fresh = await acquireFileLock(lockPath, {
			timeoutMs: 60,
			retryDelayMs: 10,
			staleMs: 60_000,
		}).catch((e: unknown) => e);
		expect(fresh).toBeInstanceOf(Error);
		age(lockPath, 120_000);
		const release = await acquireFileLock(lockPath, {
			timeoutMs: 500,
			staleMs: 60_000,
		});
		await release();
		expect(existsSync(lockPath)).toBe(false);
	});
});
