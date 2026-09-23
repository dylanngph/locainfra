import { describe, expect, test } from "bun:test";
import { BindPortProbe } from "../port-probe";

const noop = { data() {} };

describe("BindPortProbe", () => {
	const probe = new BindPortProbe();

	test("a port we are listening on (127.0.0.1) is busy", async () => {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: noop,
		});
		try {
			expect(await probe.isFree(listener.port)).toBe(false);
		} finally {
			listener.stop(true);
		}
	});

	test("the same port is free again after closing", async () => {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: noop,
		});
		const port = listener.port;
		listener.stop(true);
		expect(await probe.isFree(port)).toBe(true);
	});

	test("invalid ports are never free", async () => {
		expect(await probe.isFree(0)).toBe(false);
		expect(await probe.isFree(70000)).toBe(false);
		expect(await probe.isFree(1.5)).toBe(false);
	});
});
