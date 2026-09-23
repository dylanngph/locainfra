import { describe, expect, test } from "bun:test";
import { SystemClock } from "../clock";
import { CryptoSecretGenerator, toBase64Url } from "../secret-generator";

describe("CryptoSecretGenerator", () => {
	const gen = new CryptoSecretGenerator();

	test("produces unpadded base64url of the requested entropy", () => {
		const secret = gen.generate(24);
		expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(gen.generate(1)).toHaveLength(2);
	});

	test("is not repeating", () => {
		const values = new Set(Array.from({ length: 100 }, () => gen.generate(16)));
		expect(values.size).toBe(100);
	});

	test("rejects invalid lengths", () => {
		expect(() => gen.generate(0)).toThrow(RangeError);
		expect(() => gen.generate(2.5)).toThrow(RangeError);
	});

	test("toBase64Url replaces + and / and strips padding", () => {
		expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
	});
});

describe("SystemClock", () => {
	test("returns the current time", () => {
		const before = Date.now();
		const now = new SystemClock().now().getTime();
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});
});
