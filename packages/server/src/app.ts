import { Elysia } from "elysia";
import { doctorModule } from "./modules/doctor";
import {
	type DoctorRunner,
	DoctorService,
} from "./modules/doctor/doctor.service";
import { authGuard } from "./plugins/auth-guard";

/** Everything the server needs from the outside world. Wired by a composition root. */
export interface ServerDeps {
	/** Per-session token required on every API call except `/api/health`. */
	readonly token: string;
	/** `host:port` values the dashboard may be reached on (DNS-rebinding guard). */
	readonly allowedHosts: readonly string[];
	/** Core's doctor op and its ports. */
	readonly doctor: DoctorRunner;
}

/**
 * Composition root for the HTTP app. Pure: no `listen()`, so tests can use
 * `app.handle()`.
 *
 * @param deps - Token, allowed hosts and injected ops.
 * @returns The Elysia app.
 */
export const createApp = (deps: ServerDeps) =>
	new Elysia({ name: "LocaInfra.App" })
		.use(authGuard({ token: deps.token, allowedHosts: deps.allowedHosts }))
		.guard({ authed: true }, (app) =>
			app.use(doctorModule(new DoctorService(deps.doctor))),
		)
		.get("/api/health", () => ({ ok: true }));

/** Type of the app, for the Eden Treaty client. */
export type App = ReturnType<typeof createApp>;
