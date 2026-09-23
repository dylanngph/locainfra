import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { BUILTIN_CATALOG_FILES } from "../../catalog/builtin";
import type { ServiceDefinition } from "../../catalog/catalog.model";
import { parseServiceDefinition } from "../../catalog/loader";
import type { StateFile } from "../../ports/state.port";
import type { ResolvedStack } from "../../resolve/resolved.model";
import { resolveStack } from "../../resolve/resolver";
import type { Stack } from "../../stack/stack.model";
import {
	builtinTestDefinitions,
	createGlobalStack,
	createProjectStack,
	postgresDefinition,
} from "../../testing/catalog-fixtures";
import {
	renderCompose,
	renderComposeEnvFile,
	toComposeDocument,
} from "../compose-renderer";
import {
	LABEL_CATALOG_ID,
	LABEL_SERVICE,
	LABEL_STACK,
	LABEL_VERSION,
} from "../labels";
import { createComposeEscaper, secretVarName } from "../secret-refs";

/** Compose interpolation reference to a secret, e.g. `${LI_SECRET_X}`. */
function ref(name: string): string {
	return `$\{${secretVarName(name)}}`;
}

const secrets = {
	POSTGRES_PASSWORD: "pgSecret_0123456789abcdefghijklmnopqrstuvw",
	REDIS_PASSWORD: "redisSecret_0123456789abcdefghijklmnopqrst",
	SRH_TOKEN: "srhToken_0123456789abcdefghijklmnopqrstuvwx",
};

function resolve(
	stack: Stack,
	state: StateFile,
	definitions: readonly ServiceDefinition[] = builtinTestDefinitions,
): ResolvedStack {
	const result = resolveStack({ stack, definitions, state, secrets });
	if (!result.ok) throw result.error;
	return result.value;
}

const projectState: StateFile = {
	projects: [],
	stacks: {
		sovr: {
			ports: { postgres: 5433, redis: 6380, "upstash-redis": 8080 },
			createdAt: "2026-01-01T00:00:00Z",
		},
	},
};

/** The real built-in definitions from the repo-root `catalog/` folder. */
function loadBuiltins(): ServiceDefinition[] {
	return BUILTIN_CATALOG_FILES.map((file) => {
		const path = join(REPO_CATALOG_DIR, file);
		const parsed = parseServiceDefinition(readFileSync(path, "utf8"), path);
		if (!parsed.ok) throw parsed.error;
		return parsed.value;
	});
}

const REPO_CATALOG_DIR = fileURLToPath(
	new URL("../../../../../catalog", import.meta.url),
);

describe("renderCompose golden snapshots (built-in catalog)", () => {
	const builtins = loadBuiltins();

	test.each(builtins.map((d) => [d.id, d] as const))("%s", (id, definition) => {
		const services: Record<string, object> = { [id]: {} };
		for (const dep of definition.dependsOn ?? []) services[dep] = {};
		const stack = createProjectStack("sovr", services);
		expect(
			renderCompose(resolve(stack, projectState, builtins)),
		).toMatchSnapshot();
	});

	test("global stack with every built-in", () => {
		const services = Object.fromEntries(builtins.map((d) => [d.id, {}]));
		const resolved = resolve(
			createGlobalStack(services),
			{ projects: [], stacks: {} },
			builtins,
		);
		expect(renderCompose(resolved)).toMatchSnapshot();
		expect(renderComposeEnvFile(resolved)).toMatchSnapshot();
	});
});

describe("toComposeDocument", () => {
	const resolved = resolve(
		createProjectStack("sovr", {
			postgres: {},
			redis: {},
			"upstash-redis": {},
		}),
		projectState,
	);
	const doc = toComposeDocument(resolved);

	test("binds ports to 127.0.0.1 and names containers li-<stack>-<svc>", () => {
		expect(doc.name).toBe("li-sovr");
		expect(doc.services.postgres?.ports).toEqual(["127.0.0.1:5433:5432"]);
		expect(doc.services.postgres?.container_name).toBe("li-sovr-postgres");
		expect(doc.services.postgres?.restart).toBe("unless-stopped");
		expect(doc.services.postgres?.networks).toEqual(["li-sovr"]);
	});

	test("labels every container", () => {
		expect(doc.services.redis?.labels).toEqual({
			[LABEL_STACK]: "sovr",
			[LABEL_SERVICE]: "redis",
			[LABEL_CATALOG_ID]: "redis",
			[LABEL_VERSION]: "7",
		});
	});

	test("depends_on waits for healthy dependencies", () => {
		expect(doc.services["upstash-redis"]?.depends_on).toEqual({
			redis: { condition: "service_healthy" },
		});
		expect(doc.services.postgres?.depends_on).toBeUndefined();
	});

	test("declares named volumes and the stack network", () => {
		expect(doc.services.postgres?.volumes).toEqual([
			"li-sovr-postgres-data:/var/lib/postgresql/data",
		]);
		expect(Object.keys(doc.volumes ?? {})).toEqual([
			"li-sovr-postgres-data",
			"li-sovr-redis-data",
		]);
		expect(doc.volumes?.["li-sovr-postgres-data"]?.name).toBe(
			"li-sovr-postgres-data",
		);
		expect(doc.networks).toEqual({
			"li-sovr": { name: "li-sovr", labels: { [LABEL_STACK]: "sovr" } },
		});
	});

	test("rendered YAML contains no secret values and round-trips", () => {
		const yaml = renderCompose(resolved);
		for (const value of Object.values(secrets)) {
			expect(yaml).not.toContain(value);
		}
		expect(parse(yaml)).toEqual(JSON.parse(JSON.stringify(doc)));
		expect(doc.services.postgres?.environment?.POSTGRES_PASSWORD).toBe(
			ref("POSTGRES_PASSWORD"),
		);
		expect(
			doc.services["upstash-redis"]?.environment?.SRH_CONNECTION_STRING,
		).toBe(`redis://:${ref("REDIS_PASSWORD")}@redis:6379`);
	});

	test(".env carries every secret for interpolation", () => {
		const env = renderComposeEnvFile(resolved);
		expect(env).toContain(
			`LI_SECRET_POSTGRES_PASSWORD=${secrets.POSTGRES_PASSWORD}\n`,
		);
		expect(env).toContain(
			`LI_SECRET_REDIS_PASSWORD=${secrets.REDIS_PASSWORD}\n`,
		);
		expect(env).toContain(`LI_SECRET_SRH_TOKEN=${secrets.SRH_TOKEN}\n`);
	});

	test("literal $ is escaped so compose interpolates only secrets", () => {
		const def: ServiceDefinition = {
			...postgresDefinition,
			env: { ...postgresDefinition.env, GREETING: `cost $5 and $\{HOME}` },
		};
		const stack = createProjectStack("sovr", { postgres: {} });
		const out = toComposeDocument(resolve(stack, projectState, [def]));
		expect(out.services.postgres?.environment?.GREETING).toBe(
			`cost $$5 and $$\{HOME}`,
		);
	});
});

describe("createComposeEscaper", () => {
	test("keeps short secrets inline and escapes $ inside secret values", () => {
		const escaper = createComposeEscaper({
			SHORT: "abc",
			LONG: "pa$$word-long-1",
		});
		expect(escaper.escape("abc:pa$$word-long-1")).toBe(`abc:${ref("LONG")}`);
	});

	test("prefers the longest secret when values overlap", () => {
		const escaper = createComposeEscaper({
			A: "overlap-value",
			B: "overlap-value-extended",
		});
		expect(escaper.escape("x overlap-value-extended y")).toBe(
			`x ${ref("B")} y`,
		);
	});
});
