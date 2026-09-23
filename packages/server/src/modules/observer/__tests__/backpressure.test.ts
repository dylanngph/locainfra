import { describe, expect, it } from "bun:test";
import type { LogLine } from "@locainfra/core";
import { LogGate, type ObserverSink } from "../backpressure";
import type { ServerMessage } from "../observer.model";

/** A socket whose send status and buffered amount the test controls. */
class ScriptedSink implements ObserverSink {
	readonly id = "s1";
	readonly sent: ServerMessage[] = [];
	status = 100;
	buffered = 0;
	send(message: ServerMessage): number {
		if (this.status !== 0) this.sent.push(message);
		return this.status;
	}
	bufferedAmount(): number {
		return this.buffered;
	}
}

const lines = (n: number, prefix = "l"): LogLine[] =>
	Array.from({ length: n }, (_, i) => ({
		stream: "stdout",
		text: `${prefix}${i}`,
	}));

const payloads = (sink: ScriptedSink) =>
	sink.sent.map((m) => (m.type === "log" ? m.payload : undefined));

describe("LogGate", () => {
	it("pauses when send reports backpressure and reports skipped lines on resume", () => {
		const sink = new ScriptedSink();
		const gate = new LogGate(sink, "logs:c1", 1024);
		sink.status = -1; // queued, but congested
		gate.deliver(lines(2, "a"));
		expect(gate.isPaused).toBe(true);
		sink.status = 100;
		sink.buffered = 5000;
		gate.deliver(lines(3, "b"));
		gate.deliver(lines(4, "c"));
		expect(gate.skippedCount).toBe(7);
		expect(sink.sent).toHaveLength(1);

		gate.resume(); // still above the threshold: stays paused
		expect(gate.isPaused).toBe(true);

		sink.buffered = 0;
		gate.resume(); // drain
		expect(gate.isPaused).toBe(false);
		expect(payloads(sink).at(-1)).toEqual({ lines: [], skipped: 7 });

		gate.deliver(lines(1, "d"));
		expect(payloads(sink).at(-1)).toEqual({ lines: lines(1, "d") });
	});

	it("pauses on a large buffered amount even when send succeeded", () => {
		const sink = new ScriptedSink();
		const gate = new LogGate(sink, "logs:c1", 1024);
		sink.buffered = 2048;
		gate.deliver(lines(1));
		expect(gate.isPaused).toBe(true);
		gate.deliver(lines(2));
		sink.buffered = 10;
		// A later batch resumes by itself when the buffer went down (no drain needed).
		gate.deliver(lines(1, "z"));
		expect(payloads(sink).slice(1)).toEqual([
			{ lines: [], skipped: 2 },
			{ lines: lines(1, "z") },
		]);
	});

	it("counts dropped sends (status 0) and defers the end marker", () => {
		const sink = new ScriptedSink();
		const gate = new LogGate(sink, "logs:c1", 1024);
		sink.status = 0;
		gate.deliver(lines(3));
		expect(gate.isPaused).toBe(true);
		sink.buffered = 4096;
		sink.status = 100;
		gate.deliver([], true);
		expect(sink.sent).toHaveLength(0);
		sink.buffered = 0;
		gate.resume();
		expect(payloads(sink)).toEqual([{ lines: [], skipped: 3, ended: true }]);
	});
});
