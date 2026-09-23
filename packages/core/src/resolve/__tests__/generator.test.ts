import { describe, expect, test } from "bun:test";
import {
	InMemorySecretStore,
	SequentialSecretGenerator,
} from "../../testing/fakes";
import {
	ensureSecrets,
	SECRET_BYTES,
	uniqueSecretNames,
} from "../secrets/generator";

describe("ensureSecrets", () => {
	test("generates missing secrets with 32 bytes and persists them", async () => {
		const store = new InMemorySecretStore();
		const gen = new SequentialSecretGenerator();
		const result = await ensureSecrets(
			{ store, gen },
			{ stack: "app", names: ["POSTGRES_PASSWORD", "REDIS_PASSWORD"] },
		);
		if (!result.ok) throw result.error;
		expect(Object.keys(result.value)).toEqual([
			"POSTGRES_PASSWORD",
			"REDIS_PASSWORD",
		]);
		expect(gen.sizes).toEqual([SECRET_BYTES, SECRET_BYTES]);
		expect(SECRET_BYTES).toBe(32);
		expect(store.stacks.get("app")).toEqual(result.value);
		expect(store.writes).toBe(1);
	});

	test("never regenerates or drops existing secrets", async () => {
		const store = new InMemorySecretStore({
			app: { POSTGRES_PASSWORD: "keep-me-please", LEGACY: "old-value" },
		});
		const gen = new SequentialSecretGenerator();
		const result = await ensureSecrets(
			{ store, gen },
			{ stack: "app", names: ["POSTGRES_PASSWORD", "SRH_TOKEN"] },
		);
		if (!result.ok) throw result.error;
		expect(result.value.POSTGRES_PASSWORD).toBe("keep-me-please");
		expect(result.value.LEGACY).toBe("old-value");
		expect(result.value.SRH_TOKEN).toStartWith("secret-1-");
		expect(gen.count).toBe(1);
	});

	test("does not write when nothing is missing", async () => {
		const store = new InMemorySecretStore({ app: { A: "existing-value" } });
		const gen = new SequentialSecretGenerator();
		const result = await ensureSecrets(
			{ store, gen },
			{ stack: "app", names: ["A"] },
		);
		expect(result).toEqual({ ok: true, value: { A: "existing-value" } });
		expect(store.writes).toBe(0);
		expect(gen.count).toBe(0);
	});

	test("concurrent first-time calls agree on one value per secret", async () => {
		const store = new InMemorySecretStore();
		const gen = new SequentialSecretGenerator();
		const input = { stack: "app", names: ["POSTGRES_PASSWORD"] };
		const [a, b] = await Promise.all([
			ensureSecrets({ store, gen }, input),
			ensureSecrets({ store, gen }, input),
		]);
		if (!a.ok) throw a.error;
		if (!b.ok) throw b.error;
		expect(a.value).toEqual(b.value);
		expect(store.stacks.get("app")).toEqual(a.value);
		expect(gen.count).toBe(1);
		expect(store.writes).toBe(1);
	});

	test("store failures become IO errors", async () => {
		const store = new InMemorySecretStore();
		store.update = async () => {
			throw new Error("EACCES");
		};
		const result = await ensureSecrets(
			{ store, gen: new SequentialSecretGenerator() },
			{ stack: "app", names: ["A"] },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("IO");
	});

	test("uniqueSecretNames dedupes in first-seen order", () => {
		expect(uniqueSecretNames([["A", "B"], ["B", "C"], []])).toEqual([
			"A",
			"B",
			"C",
		]);
	});
});
