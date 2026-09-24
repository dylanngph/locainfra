import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
import { mockDb } from "./mock-db";

/** `?mockDocker=stopped|missing` previews the Docker-unavailable screen in `dev:ui`. */
const MOCK_DOCKER_PARAM = "mockDocker";

/**
 * Starts the MSW service worker for `VITE_MOCK=1` dev sessions so the
 * dashboard runs without the LocaStack server. `?mockDocker=stopped` (Start
 * Docker works) or `?mockDocker=missing` (install plan) starts with Docker
 * down.
 */
export async function startMockWorker(): Promise<void> {
	const docker = new URL(window.location.href).searchParams.get(
		MOCK_DOCKER_PARAM,
	);
	if (docker === "stopped" || docker === "missing") mockDb.docker = docker;
	await setupWorker(...handlers).start({
		onUnhandledRequest: "bypass",
		serviceWorker: { url: "/mockServiceWorker.js" },
		quiet: true,
	});
}
