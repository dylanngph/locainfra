import { Elysia } from "elysia";

export interface AuthGuardOptions {
	/** Per-session secret; must match `?t=` query or `x-locainfra-token` header. */
	token: string;
	/** Hosts the dashboard may be served on, e.g. ["127.0.0.1:4488"]. */
	allowedHosts: readonly string[];
}

/**
 * Request-dependent concern implemented as an Elysia plugin (per Elysia MVC guide).
 * Blocks DNS-rebinding (Host/Origin) and unauthenticated access to the Docker-backed API.
 */
export const authGuard = ({ token, allowedHosts }: AuthGuardOptions) =>
	new Elysia({ name: "Plugin.AuthGuard" }).macro({
		authed: {
			beforeHandle({ request, query, status }) {
				const host = request.headers.get("host") ?? "";
				if (!allowedHosts.includes(host)) return status(403, "Forbidden host");
				const origin = request.headers.get("origin");
				if (
					origin !== null &&
					!allowedHosts.some((h) => origin === `http://${h}`)
				)
					return status(403, "Forbidden origin");
				const presented = request.headers.get("x-locainfra-token") ?? query.t;
				if (presented !== token) return status(401, "Unauthorized");
			},
		},
	});
