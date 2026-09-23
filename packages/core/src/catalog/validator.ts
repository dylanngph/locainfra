import { posix } from "node:path";
import type { SchemaIssue } from "../shared/yaml-schema";
import { templatePaths } from "../template/template";
import {
	DATA_OBJECT_PLACEHOLDER,
	DATA_QUERY_PLACEHOLDER,
	type ServiceDefinition,
} from "./catalog.model";

/** Registries definitions may pull from unless the caller configures others. */
export const DEFAULT_ALLOWED_REGISTRIES: readonly string[] = [
	"docker.io",
	"ghcr.io",
	"quay.io",
];

/** Options of {@link checkDefinitionSafety}. */
export interface SafetyOptions {
	/** Registry hosts images may come from (default {@link DEFAULT_ALLOWED_REGISTRIES}). */
	readonly allowedRegistries?: readonly string[];
}

const DOCKER_HUB_ALIASES = new Set([
	"docker.io",
	"index.docker.io",
	"registry-1.docker.io",
	"registry.hub.docker.com",
]);

/** Keys that would give a container host-level access; rejected outright. */
const HOST_ACCESS_KEYS: Readonly<Record<string, string>> = {
	cap_add: "adding kernel capabilities is not allowed",
	capAdd: "adding kernel capabilities is not allowed",
	devices: "host device access is not allowed",
	security_opt: "security options are not allowed",
	securityOpt: "security options are not allowed",
	network_mode: "custom network modes (e.g. host) are not allowed",
	networkMode: "custom network modes (e.g. host) are not allowed",
	pid: "sharing the host PID namespace is not allowed",
	ipc: "sharing the host IPC namespace is not allowed",
	userns_mode: "user namespace overrides are not allowed",
	usernsMode: "user namespace overrides are not allowed",
	ports:
		"raw port publishing is not allowed; use `port` (always bound to 127.0.0.1)",
	build: "building images is not allowed; use `image` from an allowed registry",
	mounts: "raw mounts are not allowed; use named `volumes`",
};

/** Keys whose value is a bind address; anything other than loopback is rejected. */
const BIND_KEYS = new Set([
	"bind",
	"bindAddress",
	"bind_address",
	"hostIp",
	"host_ip",
	"hostIP",
]);
const ALL_INTERFACES = new Set(["0.0.0.0", "::", "[::]", "*"]);
/**
 * A compose-style publish spec bound to every interface, e.g. `0.0.0.0:5432:5432`.
 * A bare `0.0.0.0:8025` is an in-container listen address and stays allowed.
 */
const PUBLISH_ALL = /(^|[^0-9.])(0\.0\.0\.0|\[::\]):\d+:\d+/;
/** Sections whose keys are env/config names, not structural keys. */
const USER_MAPS = new Set(["/env", "/exports", "/config"]);

/** Keys of a volume entry that name a host path. */
const HOST_SOURCE_KEYS = ["source", "src", "hostPath", "host_path", "host"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(parent: string, key: string | number): string {
	return `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/**
 * Registry host of an image reference, normalised (`index.docker.io` → `docker.io`).
 * Unqualified references (`postgres:17`, `hiett/srh`) are Docker Hub.
 *
 * @param image - Image reference (templates allowed in the tag).
 * @returns Lower-cased registry host.
 */
export function imageRegistry(image: string): string {
	const slash = image.indexOf("/");
	if (slash === -1) return "docker.io";
	const first = image.slice(0, slash);
	const qualified =
		first.includes(".") || first.includes(":") || first === "localhost";
	if (!qualified) return "docker.io";
	const host = first.toLowerCase();
	return DOCKER_HUB_ALIASES.has(host) ? "docker.io" : host;
}

/** The image reference without its `:tag` / `@digest`. */
function imageRepository(image: string): string {
	const at = image.indexOf("@");
	const withoutDigest = at === -1 ? image : image.slice(0, at);
	const lastSlash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.indexOf(":", lastSlash + 1);
	return colon === -1 ? withoutDigest : withoutDigest.slice(0, colon);
}

function checkImage(
	image: unknown,
	allowed: readonly string[],
	issues: SchemaIssue[],
): void {
	if (typeof image !== "string" || image === "") return;
	if (imageRepository(image).includes("{{")) {
		issues.push({
			path: "/image",
			message:
				"only the tag may be templated; registry and repository must be literal",
		});
		return;
	}
	const registry = imageRegistry(image);
	const normalisedAllowed = allowed.map((host) =>
		DOCKER_HUB_ALIASES.has(host.toLowerCase())
			? "docker.io"
			: host.toLowerCase(),
	);
	if (!normalisedAllowed.includes(registry)) {
		issues.push({
			path: "/image",
			message: `registry "${registry}" is not allowed (allowed: ${normalisedAllowed.join(", ")})`,
		});
	}
}

function isEscapingHostPath(source: string): boolean {
	if (source === "") return false;
	if (
		source.startsWith("/") ||
		source.startsWith("~") ||
		source.startsWith("\\")
	) {
		return true;
	}
	if (/^[A-Za-z]:/.test(source)) return true;
	const normalised = posix.normalize(source.replace(/\\/g, "/"));
	return normalised === ".." || normalised.startsWith("../");
}

function checkVolumes(volumes: unknown, issues: SchemaIssue[]): void {
	if (!Array.isArray(volumes)) return;
	volumes.forEach((volume, index) => {
		const at = pointer("/volumes", index);
		if (typeof volume === "string") {
			// Compose short syntax `source:target[:mode]`.
			const source = volume.split(":")[0] ?? "";
			const isPath =
				source.includes("/") ||
				source.startsWith(".") ||
				source.startsWith("~");
			if (isPath && isEscapingHostPath(source)) {
				issues.push({
					path: at,
					message: "host mounts outside the stack directory are not allowed",
				});
			}
			return;
		}
		if (!isRecord(volume)) return;
		for (const key of HOST_SOURCE_KEYS) {
			const source = volume[key];
			if (typeof source === "string" && isEscapingHostPath(source)) {
				issues.push({
					path: pointer(at, key),
					message: "host mounts outside the stack directory are not allowed",
				});
			}
		}
		const name = volume.name;
		if (typeof name === "string" && isEscapingHostPath(name)) {
			issues.push({
				path: pointer(at, "name"),
				message: "volume names may not be host paths",
			});
		}
	});
}

function scanBinds(value: unknown, at: string, issues: SchemaIssue[]): void {
	if (typeof value === "string") {
		if (PUBLISH_ALL.test(value)) {
			issues.push({
				path: at,
				message:
					"binding to all interfaces (0.0.0.0) is not allowed; ports bind to 127.0.0.1",
			});
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			scanBinds(item, pointer(at, index), issues);
		});
		return;
	}
	if (!isRecord(value)) return;
	const userMap = USER_MAPS.has(at);
	for (const [key, child] of Object.entries(value)) {
		const childAt = pointer(at, key);
		const isBindKey =
			!userMap && (BIND_KEYS.has(key) || (at === "/port" && key === "host"));
		if (
			isBindKey &&
			typeof child === "string" &&
			ALL_INTERFACES.has(child.trim())
		) {
			issues.push({
				path: childAt,
				message:
					"binding to all interfaces (0.0.0.0) is not allowed; ports bind to 127.0.0.1",
			});
			continue;
		}
		scanBinds(child, childAt, issues);
	}
}

/**
 * Safety rules for untrusted definitions (registry, overrides), applied to the
 * raw YAML value before schema cleaning so smuggled keys are reported rather
 * than silently dropped. A definition can never run arbitrary code on the host:
 *
 * - no `privileged`, host namespaces, capabilities, devices or raw `ports`;
 * - no bind address other than loopback (`0.0.0.0`, `::`);
 * - no host mounts outside the stack directory (absolute, `~` or `..` paths);
 * - images only from allow-listed registries (unqualified → `docker.io`), with
 *   templates allowed in the tag only.
 *
 * @param raw - The definition as parsed from YAML (untrusted).
 * @param options - Registry allow-list.
 * @returns Pointer-located issues; empty when safe.
 */
export function checkDefinitionSafety(
	raw: unknown,
	options: SafetyOptions = {},
): SchemaIssue[] {
	const issues: SchemaIssue[] = [];
	if (!isRecord(raw)) return issues;
	if ("privileged" in raw && raw.privileged !== false) {
		issues.push({
			path: "/privileged",
			message: "privileged containers are not allowed",
		});
	}
	for (const [key, message] of Object.entries(HOST_ACCESS_KEYS)) {
		if (key in raw) issues.push({ path: pointer("", key), message });
	}
	scanBinds(raw, "", issues);
	checkVolumes(raw.volumes, issues);
	checkImage(
		raw.image,
		options.allowedRegistries ?? DEFAULT_ALLOWED_REGISTRIES,
		issues,
	);
	return issues;
}

type PathRule = (definition: ServiceDefinition, path: string) => string | null;

const ROOTS =
	"version, port, name, stack.name, config.*, secrets.*, services.<dependsOn id>.{host,port,secrets.*,config.*}, byType.<dependsOn id>.*";

const checkPath: PathRule = (definition, path) => {
	const segments = path.split(".");
	const [root, key, ...rest] = segments;
	switch (root) {
		case "version":
		case "port":
		case "name":
			return segments.length === 1 ? null : `"${path}" is not a known path`;
		case "stack":
			return key === "name" && rest.length === 0
				? null
				: `"${path}" is not a known path (use stack.name)`;
		case "config":
			return key !== undefined &&
				rest.length === 0 &&
				Object.hasOwn(definition.config, key)
				? null
				: `"${path}" does not name a key of \`config\``;
		case "secrets":
			return key !== undefined &&
				rest.length === 0 &&
				definition.secrets.includes(key)
				? null
				: `"${path}" does not name an entry of \`secrets\``;
		case "services":
		case "byType": {
			if (key === undefined || !(definition.dependsOn ?? []).includes(key)) {
				return `"${path}" references a service not listed in \`dependsOn\``;
			}
			const [field, name, ...extra] = rest;
			if ((field === "port" || field === "host") && name === undefined) {
				return null;
			}
			if (
				(field === "secrets" || field === "config") &&
				name !== undefined &&
				extra.length === 0
			) {
				return null;
			}
			return `"${path}" is not a known path of a dependency (host, port, secrets.*, config.*)`;
		}
		default:
			return `"${path}" is not a known path (allowed: ${ROOTS})`;
	}
};

function templateFields(
	definition: ServiceDefinition,
): Array<readonly [string, string]> {
	const fields: Array<readonly [string, string]> = [
		["/image", definition.image],
	];
	for (const [key, value] of Object.entries(definition.config)) {
		fields.push([`${pointer("/config", key)}/default`, value.default]);
	}
	for (const [section, record] of [
		["/env", definition.env],
		["/exports", definition.exports],
	] as const) {
		for (const [key, value] of Object.entries(record)) {
			fields.push([pointer(section, key), value]);
		}
	}
	for (const [section, list] of [
		["/healthcheck/test", definition.healthcheck.test],
		["/connect", definition.connect ?? []],
		["/command", definition.command ?? []],
	] as const) {
		list.forEach((value, index) => {
			fields.push([pointer(section, index), value]);
		});
	}
	if (definition.studio?.url !== undefined) {
		fields.push(["/studio/url", definition.studio.url]);
	}
	const { data, seed } = definition;
	for (const [section, list] of [
		["/data/listObjects", data?.listObjects ?? []],
		["/data/runQuery", data?.runQuery ?? []],
		["/seed/run", seed?.run ?? []],
	] as const) {
		list.forEach((value, index) => {
			// The exact `{{query}}` item is the query slot, not a template path.
			if (section === "/data/runQuery" && value === DATA_QUERY_PLACEHOLDER) {
				return;
			}
			fields.push([pointer(section, index), value]);
		});
	}
	if (data?.defaultQuery !== undefined) {
		// `{{object}}` is the selected object, filled in by listDataObjects.
		fields.push([
			"/data/defaultQuery",
			data.defaultQuery.split(DATA_OBJECT_PLACEHOLDER).join(""),
		]);
	}
	return fields;
}

const DATA_FIELDS = [
	"label",
	"listObjects",
	"objects",
	"runQuery",
	"defaultQuery",
] as const;

function checkData(definition: ServiceDefinition, issues: SchemaIssue[]): void {
	const { data } = definition;
	if (data === undefined) return;
	if (data.kind === "none") {
		for (const field of DATA_FIELDS) {
			if (data[field] !== undefined) {
				issues.push({
					path: pointer("/data", field),
					message: "must be omitted when data.kind is none",
				});
			}
		}
		return;
	}
	for (const field of ["label", "runQuery", "defaultQuery"] as const) {
		if (data[field] === undefined) {
			issues.push({
				path: pointer("/data", field),
				message: `is required when data.kind is ${data.kind}`,
			});
		}
	}
	if ((data.listObjects === undefined) === (data.objects === undefined)) {
		issues.push({
			path: "/data",
			message: "set exactly one of listObjects and objects",
		});
	}
	const slots = (data.runQuery ?? []).filter(
		(item) => item === DATA_QUERY_PLACEHOLDER,
	).length;
	if (data.runQuery !== undefined && slots !== 1) {
		issues.push({
			path: "/data/runQuery",
			message: `must contain exactly one item that is exactly ${DATA_QUERY_PLACEHOLDER} (found ${slots})`,
		});
	}
}

function checkSecretOptions(
	definition: ServiceDefinition,
	issues: SchemaIssue[],
): void {
	for (const name of Object.keys(definition.secretOptions ?? {})) {
		if (!definition.secrets.includes(name)) {
			issues.push({
				path: pointer("/secretOptions", name),
				message: "must name an entry of `secrets`",
			});
		}
	}
}

function checkImport(
	definition: ServiceDefinition,
	issues: SchemaIssue[],
): void {
	for (const [key, target] of Object.entries(definition.import?.env ?? {})) {
		const [root, name = ""] = target.split(".");
		const known =
			root === "config"
				? Object.hasOwn(definition.config, name)
				: definition.secrets.includes(name);
		if (!known) {
			issues.push({
				path: pointer("/import/env", key),
				message: `"${target}" does not name ${root === "config" ? "a key of `config`" : "an entry of `secrets`"}`,
			});
		}
	}
}

/**
 * Internal-consistency rules of a schema-valid definition:
 *
 * - `defaultVersion` is one of `versions`;
 * - `port.range` is ordered and contains `port.default`;
 * - `dependsOn` has no duplicates and not the definition itself;
 * - every `{{path}}` names something that exists (`config`/`secrets` keys,
 *   `dependsOn` services as `services.<id>` or `byType.<id>`); config
 *   defaults may not reference other config;
 * - `data`: kind `none` has no other field; otherwise `label`, `runQuery`
 *   and `defaultQuery` are set, exactly one of `listObjects` / `objects`,
 *   and `runQuery` has exactly one item that is exactly `{{query}}`.
 *   `{{query}}` is valid only there and `{{object}}` only in
 *   `defaultQuery` (anywhere else they are unknown paths); `data` argv
 *   items, `defaultQuery` and `seed.run` are template-checked;
 * - `secretOptions` keys are entries of `secrets`;
 * - `import.env` targets name a `config` key or a `secrets` entry.
 *
 * @param definition - A definition that already passed the schema.
 * @returns Pointer-located issues; empty when consistent.
 */
export function checkDefinitionConsistency(
	definition: ServiceDefinition,
): SchemaIssue[] {
	const issues: SchemaIssue[] = [];
	if (!definition.versions.includes(definition.defaultVersion)) {
		issues.push({
			path: "/defaultVersion",
			message: "must be one of `versions`",
		});
	}
	const [low, high] = definition.port.range;
	if (low > high) {
		issues.push({ path: "/port/range", message: "start must not exceed end" });
	} else if (definition.port.default < low || definition.port.default > high) {
		issues.push({
			path: "/port/default",
			message: `must lie within port.range [${low}, ${high}]`,
		});
	}
	if (!Object.hasOwn(definition.exports, definition.primaryExport)) {
		issues.push({
			path: "/primaryExport",
			message: "must name a key of `exports`",
		});
	}
	const deps = definition.dependsOn ?? [];
	if (deps.includes(definition.id)) {
		issues.push({
			path: "/dependsOn",
			message: "a service cannot depend on itself",
		});
	}
	if (new Set(deps).size !== deps.length) {
		issues.push({ path: "/dependsOn", message: "contains duplicates" });
	}
	for (const [key, value] of Object.entries(definition.config)) {
		if (value.pattern === undefined) continue;
		try {
			new RegExp(value.pattern);
		} catch {
			issues.push({
				path: `${pointer("/config", key)}/pattern`,
				message: "is not a valid regular expression",
			});
		}
	}
	checkData(definition, issues);
	checkSecretOptions(definition, issues);
	checkImport(definition, issues);
	for (const [at, template] of templateFields(definition)) {
		for (const path of templatePaths(template)) {
			const problem =
				at.startsWith("/config/") && path.startsWith("config.")
					? `"${path}": config defaults may not reference other config values`
					: checkPath(definition, path);
			if (problem !== null) {
				issues.push({ path: at, message: `template ${problem}` });
			}
		}
	}
	return issues;
}

/**
 * Cross-definition rules over a merged catalog: every `dependsOn` id exists and
 * every `{{services.<id>.secrets.X}}` / `{{byType.<id>.config.X}}` names a key
 * the dependency declares.
 *
 * @param definitions - The merged catalog.
 * @returns Issues prefixed with the offending definition id.
 */
export function checkCatalogReferences(
	definitions: readonly ServiceDefinition[],
): string[] {
	const byId = new Map(
		definitions.map((definition) => [definition.id, definition]),
	);
	const issues: string[] = [];
	for (const definition of definitions) {
		for (const dep of definition.dependsOn ?? []) {
			if (!byId.has(dep)) {
				issues.push(
					`${definition.id}: dependsOn "${dep}" is not in the catalog`,
				);
			}
		}
		for (const [at, template] of templateFields(definition)) {
			for (const path of templatePaths(template)) {
				const [root, id, field, name] = path.split(".");
				if (
					(root !== "services" && root !== "byType") ||
					id === undefined ||
					name === undefined
				)
					continue;
				const dep = byId.get(id);
				if (dep === undefined) continue;
				const known =
					field === "secrets"
						? dep.secrets.includes(name)
						: field === "config"
							? Object.hasOwn(dep.config, name)
							: true;
				if (!known) {
					issues.push(
						`${definition.id}: ${at}: template "${path}" is not declared by "${id}"`,
					);
				}
			}
		}
	}
	return issues;
}
