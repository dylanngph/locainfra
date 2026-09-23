import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { demuxLogChunks, encodeLogFrame, LogDemuxer } from "../log-demuxer";

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

describe("demuxLogChunks", () => {
	test("decodes hand-built stdout and stderr frames", () => {
		const header = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 5]);
		const bytes = concat(
			new Uint8Array([1, 0, 0, 0, 0, 0, 0, 6]),
			new TextEncoder().encode("hello\n"),
			header,
			new TextEncoder().encode("oops\n"),
		);
		expect(demuxLogChunks([bytes])).toEqual([
			{ stream: "stdout", text: "hello\n" },
			{ stream: "stderr", text: "oops\n" },
		]);
	});

	test("handles frames split across chunks at every byte boundary", () => {
		const bytes = concat(
			encodeLogFrame("stdout", "first line\n"),
			encodeLogFrame("stderr", "second\n"),
		);
		for (let cut = 1; cut < bytes.byteLength; cut++) {
			const frames = demuxLogChunks([
				bytes.subarray(0, cut),
				bytes.subarray(cut),
			]);
			expect(frames.map((f) => f.text).join("")).toBe("first line\nsecond\n");
			expect(frames.at(-1)?.stream).toBe("stderr");
		}
	});

	test("reassembles multi-byte characters split across frames", () => {
		const payload = new TextEncoder().encode("héllo ✓\n");
		const a = payload.subarray(0, 2);
		const b = payload.subarray(2);
		const frame = (p: Uint8Array) =>
			concat(new Uint8Array([1, 0, 0, 0, 0, 0, 0, p.byteLength]), p);
		const text = demuxLogChunks([frame(a), frame(b)])
			.map((f) => f.text)
			.join("");
		expect(text).toBe("héllo ✓\n");
	});

	test("skips empty frames and maps stdin/systemerr types", () => {
		const bytes = concat(
			new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]),
			new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0x61]),
			new Uint8Array([3, 0, 0, 0, 0, 0, 0, 1, 0x62]),
		);
		expect(demuxLogChunks([bytes])).toEqual([
			{ stream: "stdout", text: "a" },
			{ stream: "stderr", text: "b" },
		]);
	});

	test("rejects a non-multiplexed stream", () => {
		expect(() =>
			demuxLogChunks([new TextEncoder().encode("plain tty output\n")]),
		).toThrow(/Invalid log frame header/);
	});

	test("decodes frames recorded from a real redis container", async () => {
		const bytes = new Uint8Array(
			await Bun.file(
				join(import.meta.dir, "fixtures/redis-logs.bin"),
			).arrayBuffer(),
		);
		const frames = demuxLogChunks([bytes]);
		expect(frames).toHaveLength(4);
		for (const frame of frames) {
			expect(frame.stream).toBe("stdout");
			expect(frame.text.endsWith("\n")).toBe(true);
		}
		expect(frames[1]?.text).toContain("DB saved on disk");
	});
});

describe("LogDemuxer", () => {
	test("keeps an incomplete frame pending until completed", () => {
		const demuxer = new LogDemuxer();
		const frame = encodeLogFrame("stdout", "abc");
		expect(demuxer.push(frame.subarray(0, 5))).toEqual([]);
		expect(demuxer.pendingBytes).toBe(5);
		expect(demuxer.push(frame.subarray(5))).toEqual([
			{ stream: "stdout", text: "abc" },
		]);
		expect(demuxer.pendingBytes).toBe(0);
	});
});
