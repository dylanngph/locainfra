import { describe, expect, test } from "bun:test";
import {
	BunCommandRunner,
	mergeAsync,
	readLines,
	runToCompletion,
} from "../command-runner";

function chunked(...parts: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(encoder.encode(part));
			controller.close();
		},
	});
}

async function toArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of iterable) out.push(value);
	return out;
}

describe("readLines", () => {
	test("splits across chunks and keeps a trailing partial line", async () => {
		expect(await toArray(readLines(chunked("a\nb", "c\r\nd\re", "")))).toEqual([
			"a",
			"bc",
			"d",
			"e",
		]);
	});
});

describe("mergeAsync", () => {
	test("yields every value from every source", async () => {
		async function* gen(values: number[], delay: number) {
			for (const value of values) {
				await Bun.sleep(delay);
				yield value;
			}
		}
		const merged = await toArray(
			mergeAsync(gen([1, 2, 3], 3), gen([10, 20], 1)),
		);
		expect(merged.sort((a, b) => a - b)).toEqual([1, 2, 3, 10, 20]);
	});
});

describe("BunCommandRunner", () => {
	test("captures stdout, stderr and exit code", async () => {
		const out = await runToCompletion(new BunCommandRunner(), [
			"sh",
			"-c",
			"echo out; echo err 1>&2; exit 3",
		]);
		expect(out).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
	});

	test("throws synchronously when the executable is missing", () => {
		expect(() =>
			new BunCommandRunner().spawn(["definitely-not-a-real-binary-li"]),
		).toThrow();
	});
});
