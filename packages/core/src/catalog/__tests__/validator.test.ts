import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ServiceDefinition } from "../catalog.model";
import { parseServiceDefinition } from "../loader";
import {
	checkCatalogReferences,
	checkDefinitionConsistency,
	checkDefinitionSafety,
	imageRegistry,
} from "../validator";

const base = {
	id: "demo",
	name: "Demo",
	category: "other",
	image: "demo/app:{{version}}",
	versions: ["1"],
	defaultVersion: "1",
	port: { container: 80, default: 8080, range: [8080, 8090] },
	healthcheck: { test: ["CMD", "true"] },
	exports: { DEMO_URL: "http://127.0.0.1:{{port}}" },
	primaryExport: "DEMO_URL",
};

function paths(raw: Record<string, unknown>, allowedRegistries?: string[]) {
	return checkDefinitionSafety({ ...base, ...raw }, { allowedRegistries }).map(
		(issue) => issue.path,
	);
}

function consistency(raw: Record<string, unknown>) {
	return checkDefinitionConsistency(
		Value.Parse(ServiceDefinition, { ...base, ...raw }),
	);
}

describe("checkDefinitionSafety", () => {
	test("accepts a plain definition", () => {
		expect(paths({})).toEqual([]);
	});

	test("rejects privileged (unless explicitly false)", () => {
		expect(paths({ privileged: true })).toEqual(["/privileged"]);
		expect(paths({ privileged: "yes" })).toEqual(["/privileged"]);
		expect(paths({ privileged: false })).toEqual([]);
	});

	test("rejects host-access keys", () => {
		for (const key of [
			"cap_add",
			"devices",
			"network_mode",
			"pid",
			"ipc",
			"security_opt",
			"build",
			"mounts",
		]) {
			expect(paths({ [key]: "host" })).toEqual([`/${key}`]);
		}
	});

	test("rejects 0.0.0.0 binds", () => {
		expect(paths({ ports: ["0.0.0.0:5432:5432"] })).toEqual([
			"/ports",
			"/ports/0",
		]);
		expect(paths({ port: { ...base.port, bind: "0.0.0.0" } })).toEqual([
			"/port/bind",
		]);
		expect(paths({ port: { ...base.port, host: "0.0.0.0" } })).toEqual([
			"/port/host",
		]);
		expect(paths({ port: { ...base.port, hostIp: "::" } })).toEqual([
			"/port/hostIp",
		]);
		expect(paths({ command: ["proxy", "--publish", "0.0.0.0:80:80"] })).toEqual(
			["/command/2"],
		);
		expect(paths({ command: ["proxy", "--publish", "[::]:80:80"] })).toEqual([
			"/command/2",
		]);
	});

	test("allows loopback binds and in-container listen addresses", () => {
		expect(paths({ port: { ...base.port, bind: "127.0.0.1" } })).toEqual([]);
		expect(
			paths({
				env: {
					MP_UI_BIND_ADDR: "0.0.0.0:8025",
					HOST: "0.0.0.0",
					bind: "0.0.0.0",
				},
			}),
		).toEqual([]);
	});

	test("rejects host mounts outside the stack dir", () => {
		const volume = (extra: Record<string, unknown>) => ({
			volumes: [{ name: "data", path: "/data", ...extra }],
		});
		expect(paths(volume({ source: "/etc" }))).toEqual(["/volumes/0/source"]);
		expect(paths(volume({ source: "~/.ssh" }))).toEqual(["/volumes/0/source"]);
		expect(paths(volume({ hostPath: "../../outside" }))).toEqual([
			"/volumes/0/hostPath",
		]);
		expect(paths(volume({ source: "./init/../../x" }))).toEqual([
			"/volumes/0/source",
		]);
		expect(paths(volume({ source: "C:\\Users" }))).toEqual([
			"/volumes/0/source",
		]);
		expect(
			paths({ volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }),
		).toEqual(["/volumes/0"]);
		expect(paths({ volumes: [{ name: "/etc", path: "/x" }] })).toEqual([
			"/volumes/0/name",
		]);
	});

	test("allows paths inside the stack dir and named volumes", () => {
		expect(
			paths({ volumes: [{ name: "data", path: "/data", source: "./init" }] }),
		).toEqual([]);
		expect(paths({ volumes: ["data:/data", "./seed:/seed"] })).toEqual([]);
	});

	test("rejects images from registries outside the allow-list", () => {
		expect(paths({ image: "evil.example.com/app:1" })).toEqual(["/image"]);
		expect(paths({ image: "localhost:5000/app:1" })).toEqual(["/image"]);
		expect(paths({ image: "ghcr.io/org/app:{{version}}" })).toEqual([]);
		expect(paths({ image: "quay.io/org/app:1" })).toEqual([]);
		expect(paths({ image: "index.docker.io/library/redis:7" })).toEqual([]);
		expect(paths({ image: "postgres:{{version}}-alpine" })).toEqual([]);
	});

	test("honours a custom allow-list", () => {
		expect(
			paths({ image: "registry.acme.dev/app:1" }, ["registry.acme.dev"]),
		).toEqual([]);
		expect(paths({ image: "postgres:17" }, ["registry.acme.dev"])).toEqual([
			"/image",
		]);
	});

	test("rejects templates outside the tag", () => {
		expect(paths({ image: "{{config.IMAGE}}:1" })).toEqual(["/image"]);
		expect(paths({ image: "{{config.REGISTRY}}/app:1" })).toEqual(["/image"]);
		expect(paths({ image: "app@sha256:{{version}}" })).toEqual([]);
	});

	test("unsafe definitions fail to load even when otherwise valid", () => {
		const result = parseServiceDefinition(
			"id: demo\nname: Demo\ncategory: other\nimage: demo/app:1\nversions: ['1']\ndefaultVersion: '1'\nport: { container: 80, default: 8080, range: [8080, 8090] }\nhealthcheck: { test: [CMD, 'true'] }\nexports: { URL: x }\nprimaryExport: URL\nprivileged: true\n",
			"demo.yaml",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.issues).toEqual([
				"demo.yaml:11:1: /privileged: privileged containers are not allowed",
			]);
		}
	});
});

describe("imageRegistry", () => {
	test("normalises registry hosts", () => {
		expect(imageRegistry("postgres")).toBe("docker.io");
		expect(imageRegistry("hiett/serverless-redis-http:latest")).toBe(
			"docker.io",
		);
		expect(imageRegistry("docker.io/library/redis")).toBe("docker.io");
		expect(imageRegistry("registry-1.docker.io/library/redis")).toBe(
			"docker.io",
		);
		expect(imageRegistry("GHCR.io/a/b")).toBe("ghcr.io");
		expect(imageRegistry("localhost/app")).toBe("localhost");
		expect(imageRegistry("myhost:5000/app")).toBe("myhost:5000");
	});
});

describe("checkDefinitionConsistency", () => {
	test("accepts a consistent definition", () => {
		expect(
			consistency({
				secrets: ["A"],
				env: { A: "{{secrets.A}}:{{port}}:{{version}}:{{stack.name}}" },
			}),
		).toEqual([]);
	});

	test("config patterns must be valid regular expressions", () => {
		expect(
			consistency({
				config: {
					GOOD: { default: "a", pattern: "^[a-z]+$" },
					BAD: { default: "a", pattern: "([a-z" },
				},
			}).map((i) => i.path),
		).toEqual(["/config/BAD/pattern"]);
	});

	test("defaultVersion must be listed", () => {
		expect(consistency({ defaultVersion: "9" }).map((i) => i.path)).toEqual([
			"/defaultVersion",
		]);
	});

	test("port range must be ordered and contain the default", () => {
		expect(
			consistency({
				port: { container: 80, default: 8080, range: [9000, 8000] },
			}).map((i) => i.path),
		).toEqual(["/port/range"]);
		expect(
			consistency({
				port: { container: 80, default: 7000, range: [8000, 9000] },
			}).map((i) => i.path),
		).toEqual(["/port/default"]);
	});

	test("dependsOn may not include itself or duplicates", () => {
		expect(consistency({ dependsOn: ["demo"] }).map((i) => i.path)).toEqual([
			"/dependsOn",
		]);
		expect(consistency({ dependsOn: ["a", "a"] }).map((i) => i.path)).toEqual([
			"/dependsOn",
		]);
	});

	test("template paths must exist", () => {
		const issues = consistency({
			env: {
				A: "{{config.NOPE}}",
				B: "{{secrets.NOPE}}",
				C: "{{services.redis.port}}",
				D: "{{foo}}",
				E: "{{stack.id}}",
			},
			exports: { URL: "{{port.x}}" },
			primaryExport: "URL",
			healthcheck: { test: ["CMD", "{{version.major}}"] },
		});
		expect(issues.map((issue) => issue.path)).toEqual([
			"/env/A",
			"/env/B",
			"/env/C",
			"/env/D",
			"/env/E",
			"/exports/URL",
			"/healthcheck/test/1",
		]);
	});

	test("dependency paths are allowed only for dependsOn ids", () => {
		expect(
			consistency({
				dependsOn: ["redis"],
				env: {
					A: "{{services.redis.port}}",
					B: "{{services.redis.secrets.X}}",
					C: "{{services.redis.config.Y}}",
				},
			}),
		).toEqual([]);
		expect(
			consistency({
				dependsOn: ["redis"],
				env: { A: "{{services.redis.image}}" },
			}).map((i) => i.path),
		).toEqual(["/env/A"]);
	});

	test("byType, host and name paths are allowed for dependencies", () => {
		expect(
			consistency({
				dependsOn: ["redis"],
				env: {
					A: "{{byType.redis.port}}",
					B: "{{byType.redis.secrets.X}}",
					C: "{{services.redis.host}}",
					D: "{{byType.redis.host}}",
					E: "{{name}}",
				},
			}),
		).toEqual([]);
		expect(
			consistency({ env: { A: "{{byType.redis.port}}" } }).map((i) => i.path),
		).toEqual(["/env/A"]);
	});

	test("primaryExport must name an export", () => {
		expect(consistency({ primaryExport: "NOPE" }).map((i) => i.path)).toEqual([
			"/primaryExport",
		]);
	});

	test("config defaults may not reference config", () => {
		expect(
			consistency({
				config: { A: { default: "x" }, B: { default: "{{config.A}}" } },
			}).map((i) => i.path),
		).toEqual(["/config/B/default"]);
	});
});

describe("checkCatalogReferences", () => {
	const redis = Value.Parse(ServiceDefinition, {
		...base,
		id: "redis",
		secrets: ["REDIS_PASSWORD"],
	});

	test("flags unknown dependencies and undeclared dependency keys", () => {
		const proxy = Value.Parse(ServiceDefinition, {
			...base,
			id: "proxy",
			dependsOn: ["redis", "ghost"],
			env: {
				A: "{{services.redis.secrets.REDIS_PASSWORD}}",
				B: "{{services.redis.secrets.NOPE}}",
				C: "{{byType.redis.config.NOPE}}",
			},
		});
		expect(checkCatalogReferences([redis, proxy])).toEqual([
			'proxy: dependsOn "ghost" is not in the catalog',
			'proxy: /env/B: template "services.redis.secrets.NOPE" is not declared by "redis"',
			'proxy: /env/C: template "byType.redis.config.NOPE" is not declared by "redis"',
		]);
	});
});
