import type { ServerMessage, ServiceState } from "@locainfra/server";
import { create } from "zustand";
import {
	EMPTY_LOG_BUFFER,
	EMPTY_OBSERVER_DATA,
	forgetChannel,
	type ObserverData,
	reduceServerMessage,
} from "./observer-state";
import type { ConnectionState } from "./socket";

/** Observer data plus connection state, optimistic overrides and actions. */
export interface ObserverStore extends ObserverData {
	/** Socket connection state. */
	readonly connection: ConnectionState;
	/** `<project>/<service>` → optimistic state shown until the op settles. */
	readonly pending: Readonly<Record<string, ServiceState>>;
	/** Applies a server message. */
	apply(message: ServerMessage): void;
	/** Drops a released channel's status snapshot and error ({@link forgetChannel}). */
	forget(channel: string): void;
	/** Records the socket state. */
	setConnection(state: ConnectionState): void;
	/** Clears the rendered log lines of a container (client-side only). */
	clearLogs(containerId: string): void;
	/** Sets (or with `null`, clears) an optimistic service state. */
	setPending(key: string, state: ServiceState | null): void;
	/** Drops everything (tests, logout). */
	reset(): void;
}

/**
 * Key of an optimistic override.
 *
 * @param project - Project name.
 * @param service - Service instance name.
 * @returns `<project>/<service>`.
 */
export const pendingKey = (project: string, service: string): string =>
	`${project}/${service}`;

/** Live state fed by the observer WebSocket. */
export const useObserverStore = create<ObserverStore>()((set) => ({
	...EMPTY_OBSERVER_DATA,
	connection: "idle",
	pending: {},
	apply: (message) =>
		set((state) => {
			const next = reduceServerMessage(state, message);
			return next === state ? state : next;
		}),
	forget: (channel) =>
		set((state) => {
			const next = forgetChannel(state, channel);
			return next === state ? state : next;
		}),
	setConnection: (connection) => set({ connection }),
	clearLogs: (containerId) =>
		set((state) => {
			const buffer = state.logs[containerId];
			if (!buffer) return state;
			return {
				logs: {
					...state.logs,
					[containerId]: { ...EMPTY_LOG_BUFFER, nextId: buffer.nextId },
				},
			};
		}),
	setPending: (key, value) =>
		set((state) => {
			const pending = { ...state.pending };
			if (value === null) delete pending[key];
			else pending[key] = value;
			return { pending };
		}),
	reset: () => set({ ...EMPTY_OBSERVER_DATA, connection: "idle", pending: {} }),
}));
