import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { useCommandPaletteStore } from "@/features/command-palette/hooks/use-command-palette";
import { useLiveModeStore } from "@/shared/lib/live/live-mode";
import { configureObserver } from "@/shared/lib/observer/observer";
import { useObserverStore } from "@/shared/lib/observer/observer-store";
import type { SocketLike } from "@/shared/lib/observer/socket";
import { mockDb } from "./msw/mock-db";
import { server } from "./msw/node";

/** A socket that never connects: tests drive the observer store directly. */
const idleSocket = (): SocketLike => ({
	readyState: 0,
	send: () => {},
	close: () => {},
	onopen: null,
	onmessage: null,
	onclose: null,
	onerror: null,
});

configureObserver(idleSocket);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
	cleanup();
	server.resetHandlers();
	mockDb.reset();
	configureObserver(idleSocket);
	useObserverStore.getState().reset();
	useLiveModeStore.getState().reset();
	useCommandPaletteStore.getState().setOpen(false);
	window.localStorage.clear();
});
afterAll(() => server.close());
