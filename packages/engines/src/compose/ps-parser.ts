import type {
	ComposePublisher,
	ComposeServiceStatus,
	ContainerHealth,
} from "@locastack/core";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(obj: JsonObject, key: string): string {
	const value = obj[key];
	return typeof value === "string" ? value : "";
}

/**
 * Splits compose's comma-joined `Labels` string into a map.
 *
 * Label values may themselves contain commas (e.g. `depends_on=a:service_healthy:false,b:...`),
 * so a segment without `=` is appended to the previous value instead of starting a new label.
 *
 * @param labels - e.g. `com.docker.compose.project=x,com.docker.compose.service=db`.
 * @returns Label key → value.
 */
export function splitComposeLabels(labels: string): Record<string, string> {
	const out: Record<string, string> = {};
	let lastKey: string | undefined;
	for (const segment of labels.split(",")) {
		const eq = segment.indexOf("=");
		if (eq > 0) {
			lastKey = segment.slice(0, eq);
			out[lastKey] = segment.slice(eq + 1);
		} else if (lastKey !== undefined) {
			out[lastKey] = `${out[lastKey]},${segment}`;
		}
	}
	return out;
}

/**
 * Maps compose's `Health` field. Empty means the service has no healthcheck.
 *
 * @param health - `healthy`, `unhealthy`, `starting` or `""`.
 * @returns The health, or `undefined` for unrecognised values.
 */
export function parseComposeHealth(
	health: string,
): ContainerHealth | undefined {
	switch (health) {
		case "healthy":
		case "unhealthy":
		case "starting":
			return health;
		case "":
			return "none";
		default:
			return undefined;
	}
}

/**
 * Maps `Publishers`, keeping only published ports and collapsing IPv4/IPv6 duplicates.
 *
 * @param raw - `Publishers` array from `docker compose ps --format json`.
 * @returns Unique published ports.
 */
export function mapPublishers(raw: unknown): ComposePublisher[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Map<string, ComposePublisher>();
	for (const entry of raw) {
		if (!isObject(entry)) continue;
		const publishedPort = entry.PublishedPort;
		const targetPort = entry.TargetPort;
		if (typeof publishedPort !== "number" || typeof targetPort !== "number") {
			continue;
		}
		if (publishedPort === 0) continue;
		seen.set(`${publishedPort}:${targetPort}`, { publishedPort, targetPort });
	}
	return [...seen.values()];
}

/**
 * Maps one `docker compose ps` JSON row.
 *
 * @param raw - Untrusted row.
 * @returns The status, or `null` when `Service`/`Name` are missing.
 */
export function toComposeServiceStatus(
	raw: unknown,
): ComposeServiceStatus | null {
	if (!isObject(raw)) return null;
	const service = str(raw, "Service");
	const name = str(raw, "Name");
	if (service === "" || name === "") return null;
	const status: ComposeServiceStatus = {
		service,
		name,
		state: str(raw, "State"),
		image: str(raw, "Image"),
		publishers: mapPublishers(raw.Publishers),
	};
	const health = parseComposeHealth(str(raw, "Health"));
	if (health !== undefined) status.health = health;
	return status;
}

/**
 * Parses the raw rows of `docker compose ps --format json`, which is a JSON
 * array on older compose releases and NDJSON (one object per line) on newer ones.
 *
 * @param output - Raw stdout.
 * @returns Parsed JSON rows (unvalidated).
 * @throws SyntaxError when the output is neither a JSON array nor NDJSON.
 */
export function parseComposePsRows(output: string): unknown[] {
	const trimmed = output.trim();
	if (trimmed === "") return [];
	if (trimmed.startsWith("[")) {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : [parsed];
	}
	return trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line): unknown => JSON.parse(line));
}

/**
 * Parses `docker compose ps --format json` output (NDJSON or array), sorted by service.
 *
 * @param output - Raw stdout.
 * @returns Service statuses; malformed rows are skipped.
 * @throws SyntaxError when the output is not JSON.
 */
export function parseComposePs(output: string): ComposeServiceStatus[] {
	return parseComposePsRows(output)
		.map(toComposeServiceStatus)
		.filter((s): s is ComposeServiceStatus => s !== null)
		.sort((a, b) => a.service.localeCompare(b.service));
}

/**
 * Like {@link parseComposePs} but also exposes each row's split labels (for callers
 * that need `com.docker.compose.*` or `locastack.*` metadata).
 *
 * @param output - Raw stdout.
 * @returns Status + labels per row.
 * @throws SyntaxError when the output is not JSON.
 */
export function parseComposePsWithLabels(
	output: string,
): Array<ComposeServiceStatus & { labels: Record<string, string> }> {
	const rows: Array<ComposeServiceStatus & { labels: Record<string, string> }> =
		[];
	for (const raw of parseComposePsRows(output)) {
		const status = toComposeServiceStatus(raw);
		if (status === null || !isObject(raw)) continue;
		rows.push({ ...status, labels: splitComposeLabels(str(raw, "Labels")) });
	}
	return rows.sort((a, b) => a.service.localeCompare(b.service));
}
