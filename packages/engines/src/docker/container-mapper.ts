import type {
	ContainerFilter,
	ContainerHealth,
	ContainerSummary,
	DockerInfo,
	PortMapping,
} from "@locainfra/core";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(obj: JsonObject, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Extracts container health from the Engine API `Status` string.
 *
 * @param status - e.g. `Up 2 hours (healthy)`, `Up 3 seconds (health: starting)`.
 * @returns `healthy`, `unhealthy`, `starting`, or `none` when no healthcheck is reported.
 */
export function parseHealthFromStatus(status: string): ContainerHealth {
	if (status.includes("(unhealthy)")) return "unhealthy";
	if (status.includes("(healthy)")) return "healthy";
	if (status.includes("(health: starting)")) return "starting";
	return "none";
}

/**
 * Maps the Engine API `Ports` array to published host mappings.
 * Unpublished ports are skipped and IPv4/IPv6 duplicates collapsed.
 *
 * @param raw - `Ports` from `GET /containers/json`.
 * @returns Unique host → container mappings, ordered by host port.
 */
export function mapPorts(raw: unknown): PortMapping[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Map<string, PortMapping>();
	for (const entry of raw) {
		if (!isObject(entry)) continue;
		const host = entry.PublicPort;
		const container = entry.PrivatePort;
		if (typeof host !== "number" || typeof container !== "number") continue;
		seen.set(`${host}:${container}`, { host, container });
	}
	return [...seen.values()].sort(
		(a, b) => a.host - b.host || a.container - b.container,
	);
}

/**
 * Maps one element of `GET /containers/json` to a {@link ContainerSummary}.
 *
 * @param raw - Untrusted JSON element.
 * @returns The summary, or `null` when required fields are missing.
 */
export function toContainerSummary(raw: unknown): ContainerSummary | null {
	if (!isObject(raw)) return null;
	const id = stringField(raw, "Id");
	const image = stringField(raw, "Image");
	const state = stringField(raw, "State");
	if (id === undefined || image === undefined || state === undefined) {
		return null;
	}
	const names = Array.isArray(raw.Names)
		? raw.Names.filter((n): n is string => typeof n === "string")
		: [];
	const name = (names[0] ?? id.slice(0, 12)).replace(/^\//, "");
	const labels: Record<string, string> = {};
	if (isObject(raw.Labels)) {
		for (const [key, value] of Object.entries(raw.Labels)) {
			if (typeof value === "string") labels[key] = value;
		}
	}
	return {
		id,
		name,
		image,
		state,
		health: parseHealthFromStatus(stringField(raw, "Status") ?? ""),
		labels,
		ports: mapPorts(raw.Ports),
	};
}

/**
 * Maps `GET /version` to {@link DockerInfo}.
 *
 * @param raw - Untrusted JSON body.
 * @returns Daemon info, or `null` when `Version`/`ApiVersion` are missing.
 */
export function toDockerInfo(raw: unknown): DockerInfo | null {
	if (!isObject(raw)) return null;
	const serverVersion = stringField(raw, "Version");
	const apiVersion = stringField(raw, "ApiVersion");
	if (serverVersion === undefined || apiVersion === undefined) return null;
	const platformName = isObject(raw.Platform)
		? stringField(raw.Platform, "Name")
		: undefined;
	const info: DockerInfo = {
		serverVersion,
		apiVersion,
		os: stringField(raw, "Os") ?? "unknown",
		arch: stringField(raw, "Arch") ?? "unknown",
	};
	if (platformName !== undefined && platformName !== "") {
		info.platformName = platformName;
	}
	return info;
}

/**
 * Builds the query string for `GET /containers/json` (all containers, label filter).
 *
 * @param filter - Label filter.
 * @returns Query string without the leading `?`.
 */
export function buildContainerListQuery(filter: ContainerFilter): string {
	const params = new URLSearchParams({ all: "1" });
	const labels = Object.entries(filter.labels ?? {}).map(
		([key, value]) => `${key}=${value}`,
	);
	if (labels.length > 0) {
		params.set("filters", JSON.stringify({ label: labels }));
	}
	return params.toString();
}
