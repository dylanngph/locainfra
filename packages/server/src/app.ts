import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import type { ServerOps, ServerPorts } from "./deps";
import { catalogModule } from "./modules/catalog";
import { CatalogService } from "./modules/catalog/catalog.service";
import { dataModule } from "./modules/data";
import { DataService } from "./modules/data/data.service";
import { doctorModule } from "./modules/doctor";
import { DoctorService } from "./modules/doctor/doctor.service";
import { envModule } from "./modules/env";
import { EnvService } from "./modules/env/env.service";
import { importModule } from "./modules/import";
import { ImportService } from "./modules/import/import.service";
import { observerModule } from "./modules/observer";
import { WS_BACKPRESSURE_LIMIT } from "./modules/observer/backpressure";
import {
	type ObserverOptions,
	ObserverService,
} from "./modules/observer/observer.service";
import {
	OpRegistry,
	type OpRegistryOptions,
} from "./modules/observer/op-registry";
import { opsModule } from "./modules/ops";
import { OpEventsService } from "./modules/ops/ops.service";
import { projectsModule } from "./modules/projects";
import { ProjectsService } from "./modules/projects/projects.service";
import { servicesModule } from "./modules/services";
import { ServicesService } from "./modules/services/services.service";
import { snapshotsModule } from "./modules/snapshots";
import { SnapshotsService } from "./modules/snapshots/snapshots.service";
import { systemModule } from "./modules/system";
import { SystemService } from "./modules/system/system.service";
import { authGuard } from "./plugins/auth-guard";
import { errorHandler } from "./plugins/error-handler";
import { staticAssets } from "./plugins/static-assets";

/** Everything the server needs from the outside world. Wired by a composition root. */
export interface ServerDeps {
	/** Per-session token required on every API call except `/api/health`. */
	readonly token: string;
	/**
	 * `host:port` values the dashboard may be reached on (DNS-rebinding
	 * guard). Read on every request, so a caller may fill it after `listen`.
	 */
	readonly allowedHosts: readonly string[];
	/** Core operations (see {@link ServerOps}). */
	readonly ops: ServerOps;
	/** Every port the ops and the observer need (see {@link ServerPorts}). */
	readonly ports: ServerPorts;
	/** Version reported by `GET /api/system`. Default `0.0.0`. */
	readonly version?: string;
	/**
	 * Serve the OpenAPI reference at `/docs` (spec at `/docs/json`).
	 * Default: on unless `NODE_ENV` is `production`.
	 */
	readonly docs?: boolean;
	/**
	 * Built SPA folder to serve with an `index.html` fallback (a real folder or
	 * the compiled binary's embedded one). Omitted in development (Vite serves
	 * the SPA and proxies `/api` and `/ws`).
	 */
	readonly staticDir?: string;
	/** Observer channel timings (tests shorten them). */
	readonly observer?: ObserverOptions;
	/** Operation registry bounds. */
	readonly opRegistry?: OpRegistryOptions;
}

/** Stateful parts of the app (operation registry and WebSocket hub). */
export interface ServerRuntime {
	/** Long-running operations (`202 { opId }` and `op:<id>`). */
	readonly ops: OpRegistry;
	/** The `/ws` hub. */
	readonly observer: ObserverService;
}

/**
 * Builds the operation registry and the observer. Side-effect free: streams
 * and timers start only when a WebSocket subscribes.
 *
 * @param deps - Server dependencies.
 * @returns The runtime.
 */
export function createRuntime(deps: ServerDeps): ServerRuntime {
	const ops = new OpRegistry({
		journal: deps.ports.journal,
		...deps.opRegistry,
	});
	const observer = new ObserverService(
		{
			status: (project) => deps.ops.statusForProject(deps.ports, { project }),
			streams: deps.ports.streams,
			ops,
		},
		deps.observer,
	);
	return { ops, observer };
}

/**
 * Composition root for the HTTP app. Pure: no `listen()`, so tests can use
 * `app.handle()`. `app.stop()` closes the observer's streams.
 *
 * @param deps - Token, allowed hosts, ops and ports.
 * @param runtime - Registry and observer (default: fresh ones).
 * @returns The Elysia app.
 */
export const createApp = (
	deps: ServerDeps,
	runtime: ServerRuntime = createRuntime(deps),
) => {
	const { ports, ops } = deps;
	const launcher = runtime.ops;
	const observer = runtime.observer;
	const app = new Elysia({
		name: "LocaInfra.App",
		websocket: { backpressureLimit: WS_BACKPRESSURE_LIMIT },
	})
		.use(errorHandler)
		.use(
			openapi({
				enabled: deps.docs ?? process.env.NODE_ENV !== "production",
				// Single-segment path on purpose: the Scalar page fetches its spec by a
				// RELATIVE url ("docs/json"), which only resolves correctly from "/docs".
				// Mounting under /api/docs made the browser request /api/api/docs/json.
				path: "/docs",
				specPath: "/docs/json",
				documentation: {
					info: {
						title: "LocaInfra dashboard API",
						version: deps.version ?? "0.0.0",
						description:
							"Localhost-only API of the LocaInfra dashboard. Every route except /api/health needs the session token (?t= or x-locainfra-token).",
					},
					components: {
						securitySchemes: {
							sessionToken: {
								type: "apiKey",
								in: "header",
								name: "x-locainfra-token",
								description:
									"Session token printed by `locainfra` (also accepted as ?t=).",
							},
						},
					},
					security: [{ sessionToken: [] }],
				},
			}),
		)
		.use(authGuard({ token: deps.token, allowedHosts: deps.allowedHosts }))
		.guard({ authed: true }, (guarded) =>
			guarded
				.use(
					doctorModule(new DoctorService({ run: ops.runDoctor, deps: ports })),
				)
				.use(
					systemModule(
						new SystemService(
							ops.getSystemInfo,
							ports,
							deps.version ?? "0.0.0",
						),
					),
				)
				.use(catalogModule(new CatalogService(ops.catalogList, ports)))
				.use(
					projectsModule(new ProjectsService(ops, ports, launcher, observer)),
				)
				.use(
					servicesModule(new ServicesService(ops, ports, launcher, observer)),
				)
				.use(dataModule(new DataService(ops, ports)))
				.use(snapshotsModule(new SnapshotsService(ops, ports, launcher)))
				.use(envModule(new EnvService(ops, ports)))
				.use(importModule(new ImportService(ops, ports, launcher)))
				.use(opsModule(new OpEventsService(launcher)))
				.use(observerModule(observer)),
		)
		.get("/api/health", () => ({ ok: true }))
		.onStop(() => observer.close());
	if (deps.staticDir !== undefined)
		return app.use(
			staticAssets({ dir: deps.staticDir, allowedHosts: deps.allowedHosts }),
		);
	return app;
};

/** Type of the app, for the Eden Treaty client. */
export type App = ReturnType<typeof createApp>;
