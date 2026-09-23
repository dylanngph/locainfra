import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Contents of `~/.locainfra/dashboard.json`: how to reach the running dashboard. */
export interface DashboardFile {
	/** Server process id. */
	readonly pid: number;
	/** Port on 127.0.0.1. */
	readonly port: number;
	/** Session token (the file is 0600). */
	readonly token: string;
	/** ISO-8601 start time. */
	readonly startedAt: string;
}

function isDashboardFile(value: unknown): value is DashboardFile {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		Number.isInteger(v.pid) &&
		(v.pid as number) > 0 &&
		Number.isInteger(v.port) &&
		(v.port as number) > 0 &&
		(v.port as number) <= 65535 &&
		typeof v.token === "string" &&
		v.token.length > 0 &&
		typeof v.startedAt === "string"
	);
}

/**
 * Writes the dashboard file with mode `0600` (it holds the session token).
 *
 * @param path - File path (`dashboardFilePath(paths)`).
 * @param info - Pid, port, token and start time.
 */
export async function writeDashboardFile(
	path: string,
	info: DashboardFile,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @param path - File path.
 * @returns The parsed file, or `null` when missing or invalid.
 */
export async function readDashboardFile(
	path: string,
): Promise<DashboardFile | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isDashboardFile(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Removes the dashboard file, but only when it still describes `pid` (a newer
 * instance may have replaced it).
 *
 * @param path - File path.
 * @param pid - Pid that wrote it.
 */
export async function removeDashboardFile(
	path: string,
	pid: number,
): Promise<void> {
	const current = await readDashboardFile(path);
	if (current !== null && current.pid !== pid) return;
	await rm(path, { force: true });
}

/** Options of {@link probeDashboard}. */
export interface ProbeOptions {
	/** Abort the health request after this many ms. Default 1000. */
	readonly timeoutMs?: number;
	/** `fetch` implementation (tests). */
	readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
	/** Pid liveness check (tests). Default `process.kill(pid, 0)`. */
	readonly isAlive?: (pid: number) => boolean;
}

/** A dashboard instance that answered its health check. */
export interface RunningDashboard extends DashboardFile {
	/** `http://127.0.0.1:<port>/?t=<token>` (open this in the browser). */
	readonly url: string;
}

/**
 * Health probe for the CLI: is a dashboard already running? Reads the
 * dashboard file, checks the pid is alive and that `GET /api/health` on
 * `127.0.0.1:<port>` answers `{ ok: true }`.
 *
 * @param path - Dashboard file path (`dashboardFilePath(paths)`).
 * @param options - Timeout and injectable fetch/pid check.
 * @returns The running instance, or `null` (missing/stale file, dead pid, no answer).
 */
export async function probeDashboard(
	path: string,
	options: ProbeOptions = {},
): Promise<RunningDashboard | null> {
	const info = await readDashboardFile(path);
	if (info === null) return null;
	const isAlive = options.isAlive ?? pidAlive;
	if (!isAlive(info.pid)) return null;
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const host = `127.0.0.1:${info.port}`;
	try {
		const res = await doFetch(`http://${host}/api/health`, {
			headers: { host },
			signal: AbortSignal.timeout(options.timeoutMs ?? 1000),
		});
		if (!res.ok) return null;
		const body: unknown = await res.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("ok" in body) ||
			body.ok !== true
		)
			return null;
	} catch {
		return null;
	}
	return { ...info, url: dashboardUrl(info.port, info.token) };
}

/**
 * @param port - Dashboard port.
 * @param token - Session token.
 * @returns The URL that opens the dashboard with its token.
 */
export function dashboardUrl(port: number, token: string): string {
	return `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EPERM"
		);
	}
}
