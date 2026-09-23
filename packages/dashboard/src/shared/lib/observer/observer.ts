import { getSessionToken } from "../session-token";
import { useObserverStore } from "./observer-store";
import { ObserverSocket, type SocketFactory } from "./socket";

/**
 * URL of the observer WebSocket on the page's origin (`/ws?t=<token>`).
 *
 * @returns The absolute ws(s) URL.
 */
export function observerUrl(): string {
	const { protocol, host } = window.location;
	const url = new URL(`${protocol === "https:" ? "wss" : "ws"}://${host}/ws`);
	const token = getSessionToken();
	if (token) url.searchParams.set("t", token);
	return url.toString();
}

/** Options of {@link configureObserver}. */
export interface ObserverConfig {
	/** Grace period before an unused socket closes (tests pass 0). */
	readonly idleCloseMs?: number;
}

let socket: ObserverSocket | null = null;

/**
 * Replaces the socket factory (tests use a fake; `null` restores `WebSocket`).
 * Nothing connects until something subscribes.
 *
 * @param factory - Socket factory.
 * @param config - Idle close delay.
 */
export function configureObserver(
	factory: SocketFactory | null,
	config: ObserverConfig = {},
): void {
	socket?.dispose();
	socket = new ObserverSocket({
		url: observerUrl,
		factory: factory ?? undefined,
		idleCloseMs: config.idleCloseMs,
		onMessage: (message) => useObserverStore.getState().apply(message),
		onState: (state) => useObserverStore.getState().setConnection(state),
		onRelease: (channel) => useObserverStore.getState().forget(channel),
	});
}

const current = (): ObserverSocket => {
	if (!socket) configureObserver(null);
	return socket as ObserverSocket;
};

/**
 * Subscribes to an observer channel on the shared socket (opening it if
 * needed; it closes again shortly after the last channel is released).
 *
 * @param channel - Channel name.
 * @param tail - Log history lines (logs channels).
 * @returns Unsubscribe function.
 */
export function subscribeChannel(channel: string, tail?: number): () => void {
	return current().subscribe(channel, tail);
}

/**
 * Whether the observer socket currently exists (connecting or open).
 *
 * @returns `true` while connected.
 */
export const isObserverConnected = (): boolean => socket?.connected ?? false;
