import { describe, expect, test } from "bun:test";
import { isOpError } from "@locastack/core";
import { encodeLogFrame } from "../log-demuxer";
import {
	buildLogsQuery,
	isMultiplexedLogStream,
	LogLineAssembler,
	splitLogTimestamp,
	toDockerSince,
} from "../log-lines";

describe("splitLogTimestamp", () => {
	test("strips the RFC 3339 nano prefix and normalizes to ms ISO", () => {
		expect(
			splitLogTimestamp(
				"2026-09-23T03:39:58.100464347Z 1:M 23 Sep 2026 * Ready to accept connections",
			),
		).toEqual({
			at: "2026-09-23T03:39:58.100Z",
			text: "1:M 23 Sep 2026 * Ready to accept connections",
		});
		expect(splitLogTimestamp("2026-09-23T05:00:00+02:00 x")).toEqual({
			at: "2026-09-23T03:00:00.000Z",
			text: "x",
		});
	});

	test("keeps lines without a prefix untouched (including empty text)", () => {
		expect(splitLogTimestamp("plain line")).toEqual({ text: "plain line" });
		expect(splitLogTimestamp("2026-09-23T03:39:58Z ")).toEqual({
			at: "2026-09-23T03:39:58.000Z",
			text: "",
		});
	});
});

describe("toDockerSince / buildLogsQuery", () => {
	test("converts ISO instants to seconds.nanoseconds and passes unix through", () => {
		expect(toDockerSince("2026-09-23T03:39:58.100464347Z")).toBe(
			"1790134798.100464347",
		);
		expect(toDockerSince("2026-09-23T03:39:58Z")).toBe("1790134798.000000000");
		expect(toDockerSince("1790134798")).toBe("1790134798");
		expect(toDockerSince("1790134798.5")).toBe("1790134798.5");
	});

	test("rejects garbage with INVALID_INPUT", () => {
		const error = (() => {
			try {
				return toDockerSince("yesterday");
			} catch (e) {
				return e;
			}
		})();
		expect(isOpError(error) && error.code).toBe("INVALID_INPUT");
		expect(() => buildLogsQuery({ follow: false, tail: -1 })).toThrow();
	});

	test("builds the logs query", () => {
		const q = new URLSearchParams(
			buildLogsQuery({
				follow: true,
				tail: 5,
				since: "2026-09-23T03:39:58Z",
			}),
		);
		expect(Object.fromEntries(q)).toEqual({
			follow: "1",
			stdout: "1",
			stderr: "1",
			timestamps: "1",
			tail: "5",
			since: "1790134798.000000000",
		});
		expect(
			new URLSearchParams(buildLogsQuery({ follow: false })).get("tail"),
		).toBe("all");
	});
});

describe("isMultiplexedLogStream", () => {
	const frame = encodeLogFrame("stdout", "hello\n");
	test("trusts the content type, else sniffs the header", () => {
		expect(
			isMultiplexedLogStream("application/vnd.docker.raw-stream", frame),
		).toBe(false);
		expect(
			isMultiplexedLogStream(
				"application/vnd.docker.multiplexed-stream",
				new TextEncoder().encode("x"),
			),
		).toBe(true);
		expect(isMultiplexedLogStream("", frame)).toBe(true);
		expect(
			isMultiplexedLogStream("", new TextEncoder().encode("2026-09-23T0 raw")),
		).toBe(false);
	});
});

describe("LogLineAssembler", () => {
	test("joins partial frames per stream and splits multi-line frames", () => {
		const assembler = new LogLineAssembler();
		expect(
			assembler.push([
				{
					stream: "stdout",
					text: "2026-09-23T00:00:00Z one\n2026-09-23T00:00:01Z tw",
				},
				{ stream: "stderr", text: "2026-09-23T00:00:02Z err\r\n" },
			]),
		).toEqual([
			{ stream: "stdout", text: "one", at: "2026-09-23T00:00:00.000Z" },
			{ stream: "stderr", text: "err", at: "2026-09-23T00:00:02.000Z" },
		]);
		expect(assembler.push([{ stream: "stdout", text: "o\n" }])).toEqual([
			{ stream: "stdout", text: "two", at: "2026-09-23T00:00:01.000Z" },
		]);
		assembler.push([{ stream: "stderr", text: "\u001b[31mtrailing" }]);
		expect(assembler.end()).toEqual([
			{ stream: "stderr", text: "\u001b[31mtrailing" },
		]);
		expect(assembler.end()).toEqual([]);
	});
});
