import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOpError } from "@locainfra/core";
import { resolveDefaultPaths } from "../../paths/default-paths";
import {
	FileSecretStore,
	formatSecretsEnv,
	parseSecretsEnv,
} from "../secret-store";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "li-secrets-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("formatSecretsEnv / parseSecretsEnv", () => {
	test("round-trips awkward values", () => {
		const secrets = {
			PLAIN: "abc_DEF-123",
			SPACES: "a b c",
			DOLLAR: "p$ss",
			SINGLE: "it's",
			MULTI: 'line1\nline2 "quoted" \\ back',
			EMPTY: "",
		};
		expect(parseSecretsEnv(formatSecretsEnv(secrets))).toEqual(secrets);
	});

	test("writes base64url values bare and sorted", () => {
		expect(formatSecretsEnv({ B: "x-y_z", A: "1" })).toEndWith(
			"A=1\nB=x-y_z\n",
		);
	});

	test("rejects invalid secret names", () => {
		expect(() => formatSecretsEnv({ "BAD NAME": "x" })).toThrow();
	});

	test("parses comments, blanks and export prefixes", () => {
		expect(parseSecretsEnv("# c\n\nexport A=1\nB = '2'\n")).toEqual({
			A: "1",
			B: "2",
		});
	});
});

describe("FileSecretStore", () => {
	test("missing stack reads as empty", async () => {
		const store = new FileSecretStore(
			resolveDefaultPaths({ env: { LOCAINFRA_HOME: dir } }),
		);
		expect(await store.read("demo")).toEqual({});
	});

	test("writes <secretsDir>/<stack>.env with mode 0600 in a 0700 dir", async () => {
		const paths = resolveDefaultPaths({ env: { LOCAINFRA_HOME: dir } });
		const store = new FileSecretStore(paths);
		await store.write("demo", { POSTGRES_PASSWORD: "s3cr3t" });
		const file = join(paths.secretsDir, "demo.env");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(paths.secretsDir).mode & 0o777).toBe(0o700);
		expect(await store.read("demo")).toEqual({ POSTGRES_PASSWORD: "s3cr3t" });
		await store.write("demo", { OTHER: "x" });
		expect(await store.read("demo")).toEqual({ OTHER: "x" });
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("rejects path-traversing stack names without leaking values", async () => {
		const store = new FileSecretStore(
			resolveDefaultPaths({ env: { LOCAINFRA_HOME: dir } }),
		);
		const error = await store
			.write("../evil", { PW: "topsecret" })
			.catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("IO");
		expect(String((error as Error).message)).not.toContain("topsecret");
	});
});

describe("FileSecretStore.update", () => {
	test("two stores on one directory: concurrent first-time generation agrees on one value", async () => {
		const paths = resolveDefaultPaths({ env: { LOCAINFRA_HOME: dir } });
		const stores = [new FileSecretStore(paths), new FileSecretStore(paths)];
		let generated = 0;
		const results = await Promise.all(
			stores.map((store) =>
				store.update("app", (current) => {
					if (current.POSTGRES_PASSWORD) return undefined;
					generated++;
					return { ...current, POSTGRES_PASSWORD: `pw-${generated}-xxxxxxxx` };
				}),
			),
		);
		expect(generated).toBe(1);
		expect(results[0]).toEqual(results[1] ?? {});
		expect(await stores[0]?.read("app")).toEqual(results[0] ?? {});
		expect(statSync(join(paths.secretsDir, "app.env")).mode & 0o777).toBe(
			0o600,
		);
		expect(readdirSync(paths.secretsDir)).toEqual(["app.env"]);
	});

	test("undefined from mutate leaves the file untouched", async () => {
		const paths = resolveDefaultPaths({ env: { LOCAINFRA_HOME: dir } });
		const store = new FileSecretStore(paths);
		expect(await store.update("app", () => undefined)).toEqual({});
		expect(readdirSync(paths.secretsDir)).toEqual([]);
	});
});
