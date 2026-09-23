import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

/**
 * Starts the MSW service worker for `VITE_MOCK=1` dev sessions so the
 * dashboard runs without the LocaInfra server.
 */
export async function startMockWorker(): Promise<void> {
	await setupWorker(...handlers).start({
		onUnhandledRequest: "bypass",
		serviceWorker: { url: "/mockServiceWorker.js" },
		quiet: true,
	});
}
