import { dashboardFilePath } from "@locastack/core";
import { createApp, createRuntime, type ServerDeps } from "../app";
import {
	dashboardUrl,
	removeDashboardFile,
	writeDashboardFile,
} from "./dashboard-file";

/** The only interface the dashboard binds to. */
export const DASHBOARD_HOSTNAME = "127.0.0.1";

/** Options of {@link startServer}. */
export interface StartServerOptions {
	/** Port on 127.0.0.1; `0` picks a free one. */
	readonly port: number;
	/** Per-session token. */
	readonly token: string;
	/** Ops, ports and tuning (everything in {@link ServerDeps} but the token and hosts). */
	readonly deps: Omit<ServerDeps, "token" | "allowedHosts" | "staticDir">;
	/** Built SPA folder (`packages/dashboard/dist` or its embedded copy); omitted in dev (Vite serves it). */
	readonly staticDir?: string;
	/** Extra `host:port` values to accept, e.g. the Vite dev server `127.0.0.1:5173`. */
	readonly extraHosts?: readonly string[];
	/**
	 * Where to write `{ pid, port, token, startedAt }`. Default
	 * `~/.locastack/dashboard.json`; `false` skips it.
	 */
	readonly dashboardFile?: string | false;
	/** Stop, remove the dashboard file and exit on SIGINT/SIGTERM. Default true. */
	readonly handleSignals?: boolean;
}

/** A listening dashboard server. */
export interface RunningServer {
	/** Bound port. */
	readonly port: number;
	/** `http://127.0.0.1:<port>`. */
	readonly origin: string;
	/** URL that opens the dashboard with its token. */
	readonly url: string;
	/** Stops listening, closes streams and removes the dashboard file. Idempotent. */
	stop(): Promise<void>;
}

/**
 * Starts the dashboard server on `127.0.0.1` only: REST + `/ws`, plus the
 * SPA when `staticDir` is given. Writes the dashboard file (0600) so a second
 * `locastack` reuses this instance, and removes it on stop or SIGINT/SIGTERM.
 *
 * @param options - Port, token, deps and SPA folder.
 * @returns The running server.
 */
export async function startServer(
	options: StartServerOptions,
): Promise<RunningServer> {
	const allowedHosts: string[] = [];
	const deps: ServerDeps = {
		...options.deps,
		token: options.token,
		allowedHosts,
		...(options.staticDir === undefined
			? {}
			: { staticDir: options.staticDir }),
	};
	const app = createApp(deps, createRuntime(deps));
	app.listen({ hostname: DASHBOARD_HOSTNAME, port: options.port });
	const port = app.server?.port;
	if (port === undefined) throw new Error("The dashboard server did not start");
	allowedHosts.push(
		`${DASHBOARD_HOSTNAME}:${port}`,
		`localhost:${port}`,
		...(options.extraHosts ?? []),
	);

	const filePath =
		options.dashboardFile === false
			? undefined
			: (options.dashboardFile ?? dashboardFilePath(options.deps.ports.paths));
	if (filePath !== undefined)
		await writeDashboardFile(filePath, {
			pid: process.pid,
			port,
			token: options.token,
			startedAt: options.deps.ports.clock.now().toISOString(),
		});

	let stopping: Promise<void> | undefined;
	const onSignal = () => {
		void stop().finally(() => process.exit(0));
	};
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			await app.stop(true);
			if (filePath !== undefined)
				await removeDashboardFile(filePath, process.pid);
		})();
		return stopping;
	};
	if (options.handleSignals ?? true) {
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	}

	const origin = `http://${DASHBOARD_HOSTNAME}:${port}`;
	return { port, origin, url: dashboardUrl(port, options.token), stop };
}
