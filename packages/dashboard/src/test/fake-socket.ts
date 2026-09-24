import type { ClientMessage, ServerMessage } from "@locastack/server";
import { vi } from "vitest";
import { configureObserver } from "@/shared/lib/observer/observer";
import type { SocketLike } from "@/shared/lib/observer/socket";

/** In-memory observer socket: records what the client sends, opens on demand. */
export class FakeSocket implements SocketLike {
	readyState = 0;
	readonly sent: ClientMessage[] = [];
	closed = false;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	/** @param url - URL the client connected to. */
	constructor(readonly url: string) {}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as ClientMessage);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.readyState = 3;
		this.onclose?.(new Event("close") as CloseEvent);
	}

	/** Completes the handshake. */
	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	/** Delivers a server message. */
	receive(message: ServerMessage): void {
		this.onmessage?.(
			new MessageEvent("message", { data: JSON.stringify(message) }),
		);
	}

	/** Channels currently subscribed according to the sent messages. */
	get subscribed(): string[] {
		const open = new Set<string>();
		for (const m of this.sent)
			if (m.type === "subscribe") open.add(m.channel);
			else open.delete(m.channel);
		return [...open];
	}
}

/**
 * Routes the observer through {@link FakeSocket}s that open on the next
 * microtask and close as soon as they are unused (no grace period).
 *
 * @returns The spied factory and every socket it built.
 */
export function installFakeSockets() {
	const sockets: FakeSocket[] = [];
	const factory = vi.fn((url: string) => {
		const socket = new FakeSocket(url);
		sockets.push(socket);
		queueMicrotask(() => socket.open());
		return socket;
	});
	configureObserver(factory, { idleCloseMs: 0 });
	return { factory, sockets };
}
