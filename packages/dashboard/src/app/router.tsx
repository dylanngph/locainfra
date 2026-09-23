import type { QueryClient } from "@tanstack/react-query";
import {
	data,
	type LoaderFunctionArgs,
	type RouteObject,
	redirect,
} from "react-router";
import {
	catalogQuery,
	freePortQuery,
} from "@/features/catalog/api/catalog.queries";
import { CatalogPage } from "@/features/catalog/components/catalog-page";
import {
	ENV_FORMATS,
	type EnvFormat,
	envQuery,
} from "@/features/env/api/env.queries";
import { EnvPage } from "@/features/env/components/env-page";
import {
	projectQuery,
	projectsQuery,
} from "@/features/projects/api/projects.queries";
import { ProjectsPage } from "@/features/projects/components/projects-page";
import { serviceQuery } from "@/features/services/api/services.queries";
import { OverviewPage } from "@/features/services/components/overview-page";
import { RouteErrorBoundary } from "@/shared/components/route-error";
import { ApiRequestError } from "@/shared/lib/api-error";
import { ProjectLayout } from "./project-layout";
import { AppFallback, RootLayout } from "./root-layout";
import type { RouteHandle } from "./route-handle";

/**
 * Seeds TanStack Query from a loader; a 404 from the API becomes a route
 * error response so the nearest ErrorBoundary shows "Not found".
 */
async function ensure<T>(load: () => Promise<T>): Promise<T> {
	try {
		return await load();
	} catch (error) {
		if (error instanceof ApiRequestError && error.status === 404) {
			throw data({ message: error.message }, { status: 404 });
		}
		throw error;
	}
}

const param = (args: LoaderFunctionArgs, name: string): string => {
	const value = args.params[name];
	if (!value) throw data({ message: `Missing ${name}` }, { status: 404 });
	return value;
};

/** Query parameter `locainfra --project <dir>` adds so the dashboard opens that project. */
export const PROJECT_QUERY_PARAM = "project";

const PROJECT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * `/?project=<name>` (from `locainfra --project`) → `/p/<name>`.
 *
 * @param request - Loader request.
 * @returns A redirect, or `undefined` when there is no valid project param.
 */
export function preselectedProject(request: Request): Response | undefined {
	const name = new URL(request.url).searchParams.get(PROJECT_QUERY_PARAM);
	return name && PROJECT_NAME.test(name) ? redirect(`/p/${name}`) : undefined;
}

const envFormatOf = (request: Request): EnvFormat => {
	const fmt = new URL(request.url).searchParams.get("fmt");
	return ENV_FORMATS.find((f) => f === fmt) ?? "dotenv";
};

/**
 * Data Mode route objects. Loaders seed TanStack Query through
 * `ensureQueryData`; pages read the same queries, and live updates come from
 * the observer WebSocket store.
 *
 * @param queryClient - Client shared with the component tree.
 * @returns Route objects for `createBrowserRouter` / `createMemoryRouter`.
 */
export function createRoutes(queryClient: QueryClient): RouteObject[] {
	const handle = (crumb: RouteHandle["crumb"]): RouteHandle => ({ crumb });
	return [
		{
			id: "root",
			path: "/",
			Component: RootLayout,
			HydrateFallback: AppFallback,
			ErrorBoundary: RouteErrorBoundary,
			children: [
				{
					index: true,
					Component: ProjectsPage,
					ErrorBoundary: RouteErrorBoundary,
					loader: ({ request }) =>
						preselectedProject(request) ??
						ensure(() => queryClient.ensureQueryData(projectsQuery())),
				},
				{
					id: "project",
					path: "p/:project",
					Component: ProjectLayout,
					ErrorBoundary: RouteErrorBoundary,
					loader: async (args) => {
						const project = param(args, "project");
						void queryClient.prefetchQuery(projectsQuery());
						const [detail] = await Promise.all([
							ensure(() => queryClient.ensureQueryData(projectQuery(project))),
							ensure(() => queryClient.ensureQueryData(catalogQuery())),
						]);
						return detail.stack.name;
					},
					children: [
						{
							index: true,
							Component: OverviewPage,
							ErrorBoundary: RouteErrorBoundary,
						},
						{
							path: "add",
							Component: CatalogPage,
							ErrorBoundary: RouteErrorBoundary,
							handle: handle("catalog"),
							loader: () =>
								ensure(() => queryClient.ensureQueryData(catalogQuery())),
						},
						{
							path: "add/:type",
							lazy: async () => ({
								Component: (
									await import("@/features/config/components/config-page")
								).ConfigPage,
							}),
							ErrorBoundary: RouteErrorBoundary,
							handle: handle("config"),
							loader: async (args) => {
								const type = param(args, "type");
								const catalog = await ensure(() =>
									queryClient.ensureQueryData(catalogQuery()),
								);
								if (!catalog.definitions.some((d) => d.id === type)) {
									throw data(
										{ message: `The catalog has no service “${type}”.` },
										{ status: 404 },
									);
								}
								// Fresh on every visit; the form falls back to local rules if it fails.
								await queryClient
									.fetchQuery({ ...freePortQuery(type), staleTime: 0 })
									.catch(() => null);
								return type;
							},
						},
						{
							path: "s/:service",
							ErrorBoundary: RouteErrorBoundary,
							handle: handle("service"),
							loader: async (args) => {
								await ensure(() =>
									queryClient.ensureQueryData(
										serviceQuery(
											param(args, "project"),
											param(args, "service"),
										),
									),
								);
								return null;
							},
							lazy: async () => ({
								Component: (
									await import(
										"@/features/service-detail/components/service-detail-page"
									)
								).ServiceDetailPage,
							}),
						},
						{
							path: "env",
							Component: EnvPage,
							ErrorBoundary: RouteErrorBoundary,
							handle: handle("env"),
							loader: async (args) => {
								await ensure(() =>
									queryClient.ensureQueryData(
										envQuery(
											param(args, "project"),
											envFormatOf(args.request),
											false,
										),
									),
								);
								return null;
							},
						},
					],
				},
			],
		},
	];
}
