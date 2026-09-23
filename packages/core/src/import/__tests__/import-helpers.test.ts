// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose ${VAR} interpolation is the test data
import { describe, expect, test } from "bun:test";
import {
	hasBuild,
	parseEnvironment,
	parseLongPort,
	parsePorts,
	parseShortPort,
} from "../compose-fields";
import { parseImageRef, versionFromTag } from "../image-ref";
import { interpolateDefaults } from "../interpolation";
import { slugName, uniqueName } from "../names";

describe("interpolateDefaults", () => {
	test("keeps defaults, unescapes $$, gives up on environment reads", () => {
		expect(interpolateDefaults("plain")).toBe("plain");
		expect(interpolateDefaults("${PG_PASSWORD:-secret}")).toBe("secret");
		expect(interpolateDefaults("${PG_PASSWORD-secret}")).toBe("secret");
		expect(interpolateDefaults("pre-${A:-x}-post")).toBe("pre-x-post");
		expect(interpolateDefaults("a$$b")).toBe("a$b");
		expect(interpolateDefaults("cost $")).toBe("cost $");
		expect(interpolateDefaults("$5")).toBe("$5");
		for (const value of [
			"$HOME",
			"${HOME}",
			"${A:?required}",
			"${A:+alt}",
			"${A:-$B}",
			"${A:-x",
		]) {
			expect(interpolateDefaults(value)).toBeUndefined();
		}
	});
});

describe("parseImageRef and versionFromTag", () => {
	test("normalises Docker Hub prefixes, tags and digests", () => {
		expect(parseImageRef("postgres:16-alpine")).toEqual({
			repository: "postgres",
			tag: "16-alpine",
		});
		expect(parseImageRef("docker.io/library/Redis:7.4@sha256:abc")).toEqual({
			repository: "redis",
			tag: "7.4",
		});
		expect(parseImageRef("docker.io/postgis/postgis:16-3.4")).toEqual({
			repository: "postgis/postgis",
			tag: "16-3.4",
		});
		expect(parseImageRef("localhost:5000/pg")).toEqual({
			repository: "localhost:5000/pg",
		});
		expect(parseImageRef("mailhog/mailhog")).toEqual({
			repository: "mailhog/mailhog",
		});
		expect(parseImageRef("redis:")).toEqual({ repository: "redis" });
	});

	test("picks the tag, or its longest leading version in versions", () => {
		const versions = ["17", "16", "15", "latest"];
		expect(versionFromTag(undefined, versions)).toBeUndefined();
		expect(versionFromTag("latest", versions)).toBe("latest");
		expect(versionFromTag("16-alpine", versions)).toBe("16");
		expect(versionFromTag("16.4.1", versions)).toBe("16");
		expect(versionFromTag("v15", versions)).toBe("15");
		expect(versionFromTag("7.4", ["8", "7"])).toBe("7");
		expect(versionFromTag("9", versions)).toBeUndefined();
		expect(versionFromTag("alpine", versions)).toBeUndefined();
	});
});

describe("names", () => {
	test("slugName makes valid instance names", () => {
		expect(slugName("db")).toBe("db");
		expect(slugName("My_DB")).toBe("my-db");
		expect(slugName("web.api--v2_")).toBe("web-api-v2");
		expect(slugName("1cache")).toBe("svc-1cache");
		expect(slugName("___")).toBe("svc");
		expect(slugName("9", "app")).toBe("app-9");
	});

	test("uniqueName appends -2, -3…", () => {
		expect(uniqueName("db", new Set())).toBe("db");
		expect(uniqueName("db", new Set(["db", "db-2"]))).toBe("db-3");
	});
});

describe("compose fields", () => {
	test("short port syntax", () => {
		expect(parseShortPort("5432")).toEqual({ container: 5432 });
		expect(parseShortPort("5433:5432")).toEqual({
			host: 5433,
			container: 5432,
		});
		expect(parseShortPort("127.0.0.1:5433:5432")).toEqual({
			host: 5433,
			container: 5432,
		});
		expect(parseShortPort("127.0.0.1::5432")).toEqual({ container: 5432 });
		expect(parseShortPort("[::1]:6380:6379/tcp")).toEqual({
			host: 6380,
			container: 6379,
		});
		for (const spec of [
			"9000-9001:9000-9001",
			"${PORT}:3000",
			"53:53/udp",
			"[::1:5432",
			"70000:1",
			"a:b",
			"1:2:3:4",
			"0:5432",
		]) {
			expect(parseShortPort(spec)).toBeUndefined();
		}
	});

	test("long port syntax", () => {
		expect(
			parseLongPort({ target: 5432, published: 5433, protocol: "tcp" }),
		).toEqual({
			host: 5433,
			container: 5432,
		});
		expect(parseLongPort({ target: "6379", published: "6380" })).toEqual({
			host: 6380,
			container: 6379,
		});
		expect(parseLongPort({ target: 80 })).toEqual({ container: 80 });
		expect(parseLongPort({ target: 80, published: "" })).toEqual({
			container: 80,
		});
		expect(
			parseLongPort({ target: 53, published: 53, protocol: "udp" }),
		).toBeUndefined();
		expect(
			parseLongPort({ target: 80, published: "8000-8010" }),
		).toBeUndefined();
		expect(parseLongPort({ published: 80 })).toBeUndefined();
		expect(parseLongPort({ target: { nested: true } })).toBeUndefined();
	});

	test("ports lists mix forms and skip junk", () => {
		expect(
			parsePorts([
				"3000:3000",
				8080,
				{ target: 9000, published: 9001 },
				null,
				"x",
			]),
		).toEqual([
			{ host: 3000, container: 3000 },
			{ container: 8080 },
			{ host: 9001, container: 9000 },
		]);
		expect(parsePorts("3000:3000")).toEqual([]);
	});

	test("environment in list and map form", () => {
		expect(
			parseEnvironment([
				"POSTGRES_USER=app",
				"POSTGRES_PASSWORD=${DB_PASSWORD:-s3cret}",
				"FROM_HOST",
				"URL=postgres://${USER}@db",
				"EQ=a=b",
				42,
			]),
		).toEqual({ POSTGRES_USER: "app", POSTGRES_PASSWORD: "s3cret", EQ: "a=b" });
		expect(
			parseEnvironment({
				A: "x",
				PORT: 5432,
				DEBUG: true,
				UNSET: null,
				OBJ: { a: 1 },
				" ": "y",
			}),
		).toEqual({ A: "x", PORT: "5432", DEBUG: "true" });
		expect(parseEnvironment("A=1")).toEqual({});
	});

	test("build detection", () => {
		expect(hasBuild(".")).toBe(true);
		expect(hasBuild({ context: "." })).toBe(true);
		expect(hasBuild(undefined)).toBe(false);
		expect(hasBuild("")).toBe(false);
		expect(hasBuild(null)).toBe(false);
	});
});
