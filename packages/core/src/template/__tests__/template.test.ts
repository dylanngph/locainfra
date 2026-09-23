import { describe, expect, test } from "bun:test";
import {
	renderTemplate,
	renderTemplateList,
	renderTemplateRecord,
	templatePaths,
} from "../template";
import type { TemplateContext } from "../template.model";
import { TemplateError } from "../template.model";

const redis = {
	host: "cache",
	port: 6380,
	secrets: { REDIS_PASSWORD: "r3dis" },
	config: {},
};

const context: TemplateContext = {
	name: "main-db",
	version: "17",
	port: 5433,
	stack: { name: "shop" },
	config: { POSTGRES_USER: "postgres", POSTGRES_DB: "shop" },
	secrets: { POSTGRES_PASSWORD: "s3cret" },
	services: {
		redis,
		cache: redis,
		"upstash-redis": { host: "rest", port: 8080, secrets: {}, config: {} },
	},
	byType: { redis },
};

function thrown(fn: () => unknown): TemplateError {
	try {
		fn();
	} catch (error) {
		if (error instanceof TemplateError) return error;
		throw error;
	}
	throw new Error("expected a TemplateError");
}

describe("renderTemplate", () => {
	test("substitutes scalars, nested paths and numbers", () => {
		expect(
			renderTemplate(
				"postgres://{{config.POSTGRES_USER}}:{{secrets.POSTGRES_PASSWORD}}@127.0.0.1:{{port}}/{{config.POSTGRES_DB}}",
				context,
			),
		).toBe("postgres://postgres:s3cret@127.0.0.1:5433/shop");
		expect(renderTemplate("postgres:{{version}}-alpine", context)).toBe(
			"postgres:17-alpine",
		);
		expect(renderTemplate("{{stack.name}}", context)).toBe("shop");
	});

	test("resolves dependency paths, including hyphenated ids", () => {
		expect(
			renderTemplate(
				"redis://:{{services.redis.secrets.REDIS_PASSWORD}}@redis:{{services.redis.port}}",
				context,
			),
		).toBe("redis://:r3dis@redis:6380");
		expect(renderTemplate("{{services.upstash-redis.port}}", context)).toBe(
			"8080",
		);
	});

	test("resolves the instance name, dependency hosts, instance keys and byType", () => {
		expect(renderTemplate("{{name}}", context)).toBe("main-db");
		expect(
			renderTemplate(
				"{{services.redis.host}}|{{services.cache.port}}|{{byType.redis.host}}",
				context,
			),
		).toBe("cache|6380|cache");
		expect(() => renderTemplate("{{byType.postgres.port}}", context)).toThrow(
			TemplateError,
		);
	});

	test("tolerates whitespace inside braces", () => {
		expect(renderTemplate("{{ port }}|{{\tstack.name }}", context)).toBe(
			"5433|shop",
		);
	});

	test("returns text without placeholders unchanged", () => {
		expect(renderTemplate("", context)).toBe("");
		expect(renderTemplate("127.0.0.1", context)).toBe("127.0.0.1");
	});

	test("leaves unmatched braces as literal text", () => {
		expect(renderTemplate("a {{ b", context)).toBe("a {{ b");
		expect(renderTemplate("}} {port}", context)).toBe("}} {port}");
		expect(renderTemplate("{{{port}}}", context)).toBe("{5433}");
	});

	test("does not re-expand substituted values (single pass)", () => {
		const tricky: TemplateContext = {
			...context,
			secrets: { POSTGRES_PASSWORD: "{{port}}" },
		};
		expect(renderTemplate("{{secrets.POSTGRES_PASSWORD}}", tricky)).toBe(
			"{{port}}",
		);
	});

	test("unknown path throws TemplateError listing the path", () => {
		const error = thrown(() => renderTemplate("x{{config.NOPE}}y", context));
		expect(error.paths).toEqual(["config.NOPE"]);
		expect(error.issues[0]?.reason).toBe("unknown");
		expect(error.message).toContain("{{config.NOPE}}");
	});

	test("lists every unknown path once, in order", () => {
		const error = thrown(() =>
			renderTemplate("{{a}} {{b.c}} {{a}} {{port}}", context),
		);
		expect(error.paths).toEqual(["a", "b.c"]);
	});

	test("rejects non-scalar, empty, prototype and malformed paths", () => {
		expect(thrown(() => renderTemplate("{{config}}", context)).issues).toEqual([
			{ path: "config", reason: "not-scalar" },
		]);
		expect(thrown(() => renderTemplate("{{ }}", context)).issues).toEqual([
			{ path: "", reason: "empty" },
		]);
		expect(
			thrown(() => renderTemplate("{{config.constructor}}", context)).paths,
		).toEqual(["config.constructor"]);
		expect(
			thrown(() => renderTemplate("{{secrets.__proto__}}", context)).paths,
		).toEqual(["secrets.__proto__"]);
		expect(thrown(() => renderTemplate("{{port..x}}", context)).paths).toEqual([
			"port..x",
		]);
		expect(thrown(() => renderTemplate("{{port.x}}", context)).paths).toEqual([
			"port.x",
		]);
	});

	test("error messages never contain resolved secret values", () => {
		const error = thrown(() =>
			renderTemplate("{{secrets.POSTGRES_PASSWORD}}{{nope}}", context),
		);
		expect(error.message).not.toContain("s3cret");
	});
});

describe("renderTemplateRecord / renderTemplateList", () => {
	test("render every value, keeping order", () => {
		expect(
			renderTemplateRecord({ A: "{{port}}", B: "{{stack.name}}" }, context),
		).toEqual({ A: "5433", B: "shop" });
		expect(
			renderTemplateList(["CMD-SHELL", "pg_isready -p {{port}}"], context),
		).toEqual(["CMD-SHELL", "pg_isready -p 5433"]);
	});

	test("aggregate unknown paths across values", () => {
		const error = thrown(() =>
			renderTemplateRecord({ A: "{{x}}", B: "{{y}}", C: "{{x}}" }, context),
		);
		expect(error.paths).toEqual(["x", "y"]);
		expect(
			thrown(() => renderTemplateList(["{{z}}", "ok"], context)).paths,
		).toEqual(["z"]);
	});
});

describe("templatePaths", () => {
	test("lists referenced paths once, trimmed", () => {
		expect(templatePaths("{{ port }}:{{config.A}}/{{port}}")).toEqual([
			"port",
			"config.A",
		]);
		expect(templatePaths("none")).toEqual([]);
	});
});
