import type { ClientMessage } from "@locastack/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObserverSocket, type SocketLike } from "../socket";

class Fake implements SocketLike {
	readyState = 0;
	sent: ClientMessage[] = [];
	closed = false;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data) as ClientMessage);
	}
	close() {
		this.closed = true;
		this.readyState = 3;
		this.onclose?.(new Event("close") as CloseEvent);
	}
	open() {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}
}

const setup = (idleCloseMs = 1_000) => {
	const sockets: Fake[] = [];
	const released: string[] = [];
	const states: string[] = [];
	const factory = vi.fn(() => {
		const s = new Fake();
		sockets.push(s);
		return s;
	});
	const observer = new ObserverSocket({
		url: () => "ws://127.0.0.1/ws",
		factory,
		idleCloseMs,
		onMessage: () => {},
		onState: (s) => states.push(s),
		onRelease: (c) => released.push(c),
	});
	return { observer, factory, sockets, released, states };
};

describe("ObserverSocket", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not connect until something subscribes", () => {
		const { factory } = setup();
		expect(factory).not.toHaveBeenCalled();
	});

	it("closes after the idle grace once the last channel is released, without reconnecting", () => {
		const { observer, factory, sockets, released, states } = setup();
		const release = observer.subscribe("status:shop");
		sockets[0]?.open();
		expect(sockets[0]?.sent).toEqual([
			{ type: "subscribe", channel: "status:shop" },
		]);
		release();
		expect(released).toEqual(["status:shop"]);
		expect(sockets[0]?.sent.at(-1)).toEqual({
			type: "unsubscribe",
			channel: "status:shop",
		});
		expect(sockets[0]?.closed).toBe(false);
		vi.advanceTimersByTime(1_000);
		expect(sockets[0]?.closed).toBe(true);
		expect(states.at(-1)).toBe("idle");
		vi.advanceTimersByTime(60_000);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(observer.connected).toBe(false);
	});

	it("reuses the socket when a channel is subscribed again within the grace", () => {
		const { observer, factory, sockets } = setup();
		observer.subscribe("op:1")();
		sockets[0]?.open();
		vi.advanceTimersByTime(500);
		const release = observer.subscribe("status:shop");
		vi.advanceTimersByTime(5_000);
		expect(sockets[0]?.closed).toBe(false);
		expect(factory).toHaveBeenCalledTimes(1);
		release();
		vi.advanceTimersByTime(1_000);
		expect(sockets[0]?.closed).toBe(true);
	});

	it("opens a fresh socket after an idle close", () => {
		const { observer, factory, sockets } = setup(0);
		observer.subscribe("op:1")();
		vi.advanceTimersByTime(0);
		expect(sockets[0]?.closed).toBe(true);
		observer.subscribe("status:shop");
		expect(factory).toHaveBeenCalledTimes(2);
	});
});
