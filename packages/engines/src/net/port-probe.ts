import type { PortProbe } from "@locainfra/core";

/** Loopback address every probe (and every LocaInfra service) uses. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Options for {@link BindPortProbe}. */
export interface BindPortProbeOptions {
	/** Timeout of the connect check in milliseconds (default 250). */
	readonly connectTimeoutMs?: number;
}

const noopSocketHandler = {
	data(): void {},
};

/**
 * {@link PortProbe} that bind-probes `127.0.0.1:<port>` with `Bun.listen` and
 * immediately closes the listener.
 *
 * On macOS a listener on `0.0.0.0` does not block a `127.0.0.1` bind, so a
 * successful bind is followed by a loopback connect attempt: if something
 * accepts the connection, the port is reported busy.
 */
export class BindPortProbe implements PortProbe {
	readonly #connectTimeoutMs: number;

	/** @param options - Probe tuning. */
	constructor(options: BindPortProbeOptions = {}) {
		this.#connectTimeoutMs = options.connectTimeoutMs ?? 250;
	}

	/**
	 * @param port - TCP port (1–65535).
	 * @returns `true` when the port can be bound on 127.0.0.1 and nothing answers on it.
	 */
	async isFree(port: number): Promise<boolean> {
		if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
		if (!this.#canBind(port)) return false;
		return !(await this.#answers(port));
	}

	#canBind(port: number): boolean {
		try {
			const listener = Bun.listen({
				hostname: LOOPBACK_HOST,
				port,
				socket: noopSocketHandler,
			});
			listener.stop(true);
			return true;
		} catch {
			return false;
		}
	}

	async #answers(port: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.#connectTimeoutMs);
		});
		const attempt = Bun.connect({
			hostname: LOOPBACK_HOST,
			port,
			socket: noopSocketHandler,
		}).then(
			(socket) => {
				socket.end();
				return true;
			},
			() => false,
		);
		try {
			return await Promise.race([attempt, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
}
