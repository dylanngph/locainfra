import { describe, expect, it } from "vitest";
import { entryToYaml, yamlToEntry } from "../entry-yaml";

describe("entry YAML", () => {
	it("round-trips an instance entry", () => {
		const text = entryToYaml("main-db", {
			type: "postgres",
			version: "17",
			port: 5433,
			persist: "volume",
			config: { POSTGRES_DB: "shop" },
		});
		expect(text).toBe(
			'services:\n  main-db:\n    type: postgres\n    version: "17"\n    port: 5433\n    persist: volume\n    config:\n      POSTGRES_DB: shop\n',
		);
		expect(yamlToEntry(text, "postgres")).toEqual({
			ok: true,
			name: "main-db",
			version: "17",
			port: "5433",
			persist: "volume",
			config: { POSTGRES_DB: "shop" },
		});
	});

	it("reports invalid documents", () => {
		expect(yamlToEntry("services: [", "postgres").ok).toBe(false);
		expect(yamlToEntry("services:\n  a: {}\n  b: {}\n", "postgres")).toEqual({
			ok: false,
			error: "Describe exactly one service here.",
		});
		expect(
			yamlToEntry("services:\n  a:\n    type: redis\n", "postgres"),
		).toEqual({
			ok: false,
			error: "type is postgres on this page.",
		});
		expect(
			yamlToEntry("services:\n  a:\n    persist: forever\n", "postgres").ok,
		).toBe(false);
	});
});
