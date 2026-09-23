import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_CATALOG_FILES } from "../../catalog/builtin";
import type { ServiceDefinition } from "../../catalog/catalog.model";
import { parseServiceDefinition } from "../../catalog/loader";
import type { StateFile } from "../../ports/state.port";
import { resolveStack } from "../../resolve/resolver";
import type { Stack } from "../../stack/stack.model";
import { createProjectStack } from "../../testing/catalog-fixtures";
import { renderCompose, toComposeDocument } from "../compose-renderer";

const REPO_CATALOG_DIR = fileURLToPath(
	new URL("../../../../../catalog", import.meta.url),
);

function loadBuiltins(): ServiceDefinition[] {
	return BUILTIN_CATALOG_FILES.map((file) => {
		const path = join(REPO_CATALOG_DIR, file);
		const parsed = parseServiceDefinition(readFileSync(path, "utf8"), path);
		if (!parsed.ok) throw parsed.error;
		return parsed.value;
	});
}

const state: StateFile = {
	projects: [],
	stacks: {
		shop: {
			ports: { "main-db": 5433, events: 5434 },
			createdAt: "2026-01-01T00:00:00Z",
		},
	},
};

const secrets = {
	MAIN_DB__POSTGRES_PASSWORD: "mainDbSecret_0123456789abcdefghijklmnopq",
	EVENTS__POSTGRES_PASSWORD: "eventsSecret_0123456789abcdefghijklmnopq",
};

function render(stack: Stack) {
	const result = resolveStack({
		stack,
		definitions: loadBuiltins(),
		state,
		secrets,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

describe("seed file bind mount", () => {
	const stack: Stack = {
		...createProjectStack("shop", {
			"main-db": { type: "postgres", seed: "db/seed.sql" },
			events: {
				type: "postgres",
				persist: "ephemeral",
				seed: "db/$events.sql",
			},
		}),
		root: "/Users/dev/Developer/shop",
		filePath: "/Users/dev/Developer/shop/locainfra.yaml",
	};

	test("golden: read-only long-syntax bind after the data volume", () => {
		expect(renderCompose(render(stack))).toMatchSnapshot();
	});

	test("resolves <root>/<seed> to <mountPath>/<fileName>; escapes $ for compose", () => {
		const resolved = render(stack);
		expect(resolved.services.find((s) => s.name === "main-db")?.seed).toEqual({
			source: "/Users/dev/Developer/shop/db/seed.sql",
			root: "/Users/dev/Developer/shop",
			target: "/docker-entrypoint-initdb.d/seed.sql",
		});
		const doc = toComposeDocument(resolved);
		expect(doc.services.events?.volumes).toEqual([
			{
				type: "bind",
				source: "/Users/dev/Developer/shop/db/$$events.sql",
				target: "/docker-entrypoint-initdb.d/seed.sql",
				read_only: true,
				bind: { create_host_path: false },
			},
		]);
	});

	test("no seed, or a definition without a seed block: no mount", () => {
		const plain = render({
			...stack,
			file: { ...stack.file, services: { "main-db": { type: "postgres" } } },
		});
		expect(plain.services[0]?.seed).toBeUndefined();
		expect(toComposeDocument(plain).services["main-db"]?.volumes).toEqual([
			"li-shop-main-db-data:/var/lib/postgresql/data",
		]);
	});

	test("a seed that resolves outside the project folder is INVALID_STACK", () => {
		const result = resolveStack({
			stack: {
				...stack,
				file: {
					...stack.file,
					services: { "main-db": { type: "postgres", seed: "." } },
				},
			},
			definitions: loadBuiltins(),
			state,
			secrets,
		});
		expect(!result.ok && result.error.code).toBe("INVALID_STACK");
	});
});
