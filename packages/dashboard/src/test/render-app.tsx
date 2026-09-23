import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBrowserRouter, RouterProvider } from "react-router";
import { afterEach } from "vitest";
import { AppProviders } from "@/app/providers";
import { createRoutes } from "@/app/router";
import { createQueryClient } from "@/shared/lib/query-client";

const routers: { dispose(): void }[] = [];

afterEach(() => {
	for (const router of routers.splice(0)) router.dispose();
	window.history.replaceState(null, "", "/");
});

/**
 * Renders the whole app (real routes, loaders and providers) at a path, over
 * the MSW mock API. Uses a browser router on happy-dom's history because nuqs
 * writes shallow URL updates straight to `window.history`.
 *
 * @param path - Initial URL, e.g. `/p/shop-api?tab=logs`.
 * @returns The router, query client and a user-event instance.
 */
export function renderApp(path: string) {
	window.history.replaceState(null, "", path);
	const queryClient = createQueryClient();
	queryClient.setDefaultOptions({
		queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
	});
	const router = createBrowserRouter(createRoutes(queryClient));
	routers.push(router);
	const user = userEvent.setup();
	const view = render(
		<AppProviders queryClient={queryClient}>
			<RouterProvider router={router} />
		</AppProviders>,
	);
	return { ...view, router, queryClient, user };
}

/** Current `window.location.search` (where nuqs writes filters). */
export const currentSearch = (): string => window.location.search;
