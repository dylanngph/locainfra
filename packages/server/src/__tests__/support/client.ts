import { createApp, createRuntime } from "../../app";
import { createTestDeps, HOST, TOKEN } from "./fixtures";

/**
 * Builds the app over the fixtures and a raw request helper.
 *
 * @param overrides - Extra deps (ops, ports…).
 * @returns The deps, the runtime (op registry) and `call(method, path, body?, token?)`.
 */
export function setupApp(overrides: Parameters<typeof createTestDeps>[0] = {}) {
	const deps = createTestDeps(overrides);
	const runtime = createRuntime(deps);
	const app = createApp(deps, runtime);
	const call = (
		method: string,
		path: string,
		body?: unknown,
		token: string | undefined = TOKEN,
	) =>
		app.handle(
			new Request(`http://${HOST}${path}`, {
				method,
				headers: {
					host: HOST,
					...(token ? { "x-locastack-token": token } : {}),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	return { deps, runtime, app, call };
}

/**
 * Reads the OpenAPI spec's paths.
 *
 * @param call - Request helper of {@link setupApp}.
 * @returns The `paths` object of `/docs/json`.
 */
export async function specPaths(
	call: ReturnType<typeof setupApp>["call"],
): Promise<
	Record<string, Record<string, { responses?: Record<string, unknown> }>>
> {
	const response = await call("GET", "/docs/json");
	const spec = (await response.json()) as {
		paths: Record<
			string,
			Record<string, { responses?: Record<string, unknown> }>
		>;
	};
	return spec.paths;
}
