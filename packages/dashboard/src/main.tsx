import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "./index.css";
import { AppProviders } from "@/app/providers";
import { createRoutes } from "@/app/router";
import { createQueryClient } from "@/shared/lib/query-client";
import { initSessionToken } from "@/shared/lib/session-token";

async function start(): Promise<void> {
	if (import.meta.env.VITE_MOCK === "1") {
		const { startMockWorker } = await import("@/test/msw/browser");
		await startMockWorker();
	}
	// Read ?t= before the router snapshots the URL, then strip it from the address bar.
	initSessionToken();

	const rootElement = document.getElementById("root");
	if (!rootElement) throw new Error("Missing #root element");

	const queryClient = createQueryClient();
	const router = createBrowserRouter(createRoutes(queryClient));

	createRoot(rootElement).render(
		<StrictMode>
			<AppProviders queryClient={queryClient}>
				<RouterProvider router={router} />
			</AppProviders>
		</StrictMode>,
	);
}

void start();
