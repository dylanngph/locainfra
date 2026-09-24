import type {
	DaemonWaiter,
	DockerInfoPort,
	SocketLocator,
} from "@locastack/core";
import { DockerClient } from "./docker-client";
import { UnixSocketTransport } from "./unix-socket-transport";

/** Delay between two {@link PollingDaemonWaiter} attempts. */
export const DAEMON_POLL_INTERVAL_MS = 2_000;

/** Deadline of one attempt (locate the socket, then `GET /version`). */
export const DAEMON_ATTEMPT_TIMEOUT_MS = 5_000;

/** Options of {@link PollingDaemonWaiter}. */
export interface PollingDaemonWaiterOptions {
	/** Finds the socket; asked again on every attempt (a fresh runtime creates its socket or context late). */
	readonly locator: SocketLocator;
	/**
	 * Engine API client for a located socket (default a fresh
	 * {@link DockerClient} over a {@link UnixSocketTransport} per attempt, so
	 * no socket or API version is cached across attempts).
	 */
	readonly connect?: (socketPath: string) => DockerInfoPort;
	/** Delay between attempts (default {@link DAEMON_POLL_INTERVAL_MS}). */
	readonly intervalMs?: number;
	/** Deadline of one attempt (default {@link DAEMON_ATTEMPT_TIMEOUT_MS}). */
	readonly attemptTimeoutMs?: number;
	/** Monotonic milliseconds (default `performance.now()`). */
	readonly now?: () => number;
}

function defaultConnect(socketPath: string): DockerInfoPort {
	return new DockerClient(new UnixSocketTransport({ socketPath }));
}

/** Resolves after `ms`, or early when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, Math.max(0, ms));
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * {@link DaemonWaiter} that polls: locate the socket with the
 * {@link SocketLocator}, then ask the daemon (`DockerClient.info`, i.e.
 * `GET /version`) every {@link DAEMON_POLL_INTERVAL_MS} until it answers, the
 * deadline passes or the signal aborts. Read only. Never rejects.
 */
export class PollingDaemonWaiter implements DaemonWaiter {
	readonly #locator: SocketLocator;
	readonly #connect: (socketPath: string) => DockerInfoPort;
	readonly #intervalMs: number;
	readonly #attemptTimeoutMs: number;
	readonly #now: () => number;

	/** @param options - Locator plus overrides for tests. */
	constructor(options: PollingDaemonWaiterOptions) {
		this.#locator = options.locator;
		this.#connect = options.connect ?? defaultConnect;
		this.#intervalMs = options.intervalMs ?? DAEMON_POLL_INTERVAL_MS;
		this.#attemptTimeoutMs =
			options.attemptTimeoutMs ?? DAEMON_ATTEMPT_TIMEOUT_MS;
		this.#now = options.now ?? (() => performance.now());
	}

	/**
	 * @param timeoutMs - Give up after this long (one attempt is always made).
	 * @param signal - Stops waiting early (resolves `false`).
	 * @returns `true` as soon as the Engine API answers, `false` on timeout or abort.
	 */
	async waitForDocker(
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		const deadline = this.#now() + timeoutMs;
		for (;;) {
			if (signal?.aborted) return false;
			const remaining = deadline - this.#now();
			if (
				await this.#attempt(
					Math.max(1, Math.min(this.#attemptTimeoutMs, remaining)),
					signal,
				)
			) {
				return true;
			}
			if (signal?.aborted) return false;
			const left = deadline - this.#now();
			if (left <= 0) return false;
			await pause(Math.min(this.#intervalMs, left), signal);
		}
	}

	/** One locate + info, bounded by `limitMs` and `signal`; `true` when the daemon answered. */
	async #attempt(
		limitMs: number,
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		const stop = new AbortController();
		const onAbort = (): void => stop.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const probe = (async (): Promise<boolean> => {
			const socket = await this.#locator.locate();
			if (socket === null || stop.signal.aborted) return false;
			await this.#connect(socket).info();
			return true;
		})().catch(() => false);
		try {
			return await Promise.race([
				probe,
				pause(limitMs, stop.signal).then(() => false),
			]);
		} finally {
			stop.abort();
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
