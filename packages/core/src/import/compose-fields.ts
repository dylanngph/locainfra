import type { ComposeImportPort } from "../ops/ops.model";
import { interpolateDefaults } from "./interpolation";

/**
 * @param value - Anything.
 * @returns Whether it is a plain (non-array) object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return undefined;
}

function portNumber(text: string): number | undefined {
	if (!/^\d{1,5}$/.test(text)) return undefined;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Parses one short-syntax compose port: `[IP:][HOST:]CONTAINER[/PROTO]`
 * (`"5432"`, `"5433:5432"`, `"127.0.0.1:5433:5432"`, `"[::1]:5433:5432"`,
 * `"127.0.0.1::5432"`). Ranges, UDP and interpolated ports are skipped.
 *
 * @param spec - The port item.
 * @returns The mapping, or `undefined` when skipped.
 */
export function parseShortPort(spec: string): ComposeImportPort | undefined {
	if (spec.includes("$")) return undefined;
	let rest = spec.trim();
	const slash = rest.indexOf("/");
	if (slash !== -1) {
		if (rest.slice(slash + 1).toLowerCase() !== "tcp") return undefined;
		rest = rest.slice(0, slash);
	}
	if (rest.startsWith("[")) {
		const close = rest.indexOf("]:");
		if (close === -1) return undefined;
		rest = rest.slice(close + 2);
	}
	const parts = rest.split(":");
	if (parts.length > 3 || parts.some((part) => part.includes("-"))) {
		return undefined;
	}
	const containerText = parts.at(-1) ?? "";
	const hostText = parts.length >= 2 ? (parts.at(-2) ?? "") : "";
	const container = portNumber(containerText);
	if (container === undefined) return undefined;
	if (hostText === "") return { container };
	const host = portNumber(hostText);
	return host === undefined ? undefined : { host, container };
}

/**
 * Parses one long-syntax compose port (`{ target, published, protocol }`).
 *
 * @param spec - The port item.
 * @returns The mapping, or `undefined` when skipped (range, UDP, interpolated).
 */
export function parseLongPort(
	spec: Record<string, unknown>,
): ComposeImportPort | undefined {
	const protocol = scalarText(spec.protocol);
	if (protocol !== undefined && protocol.toLowerCase() !== "tcp")
		return undefined;
	const targetText = scalarText(spec.target);
	const container =
		targetText === undefined ? undefined : portNumber(targetText);
	if (container === undefined) return undefined;
	const publishedText = scalarText(spec.published);
	if (publishedText === undefined || publishedText === "") return { container };
	const host = portNumber(publishedText);
	return host === undefined ? undefined : { host, container };
}

/**
 * @param value - Compose `ports` (list of short strings, numbers or long-syntax maps).
 * @returns The usable mappings, in order.
 */
export function parsePorts(value: unknown): ComposeImportPort[] {
	if (!Array.isArray(value)) return [];
	const ports: ComposeImportPort[] = [];
	for (const item of value) {
		const parsed = isRecord(item)
			? parseLongPort(item)
			: typeof item === "string" || typeof item === "number"
				? parseShortPort(String(item))
				: undefined;
		if (parsed !== undefined) ports.push(parsed);
	}
	return ports;
}

/**
 * @param value - Compose `environment`, list (`KEY=VALUE`) or map form.
 * @returns Variables with a known value, as strings: `${VAR:-default}`
 *   keeps its default; values that need the environment, `KEY` without a
 *   value and `null` are left out.
 */
export function parseEnvironment(value: unknown): Record<string, string> {
	const env: Record<string, string> = {};
	const set = (key: string, raw: string | undefined) => {
		const name = key.trim();
		if (name === "" || raw === undefined) return;
		const resolved = interpolateDefaults(raw);
		if (resolved !== undefined) env[name] = resolved;
	};
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== "string") continue;
			const eq = item.indexOf("=");
			if (eq === -1) continue;
			set(item.slice(0, eq), item.slice(eq + 1));
		}
	} else if (isRecord(value)) {
		for (const [key, raw] of Object.entries(value)) set(key, scalarText(raw));
	}
	return env;
}

/**
 * @param value - Compose `build` (a context string or a map).
 * @returns Whether the service builds its image from source.
 */
export function hasBuild(value: unknown): boolean {
	return (typeof value === "string" && value !== "") || isRecord(value);
}
