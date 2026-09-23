const MB = 1024 * 1024;

/** Shown instead of a CPU/MEM figure the dashboard has no reading for (Live off). */
export const NO_READING = "—";

/** Tooltip of a {@link NO_READING} CPU/MEM figure. */
export const NO_READING_HINT = "Turn on Live to see CPU and memory";

/**
 * Formats a CPU percentage like the prototype (`2.4%`). Only for real
 * readings: show {@link NO_READING} when there is none.
 *
 * @param percent - Percent of one CPU.
 * @returns e.g. `2.4%`.
 */
export function formatCpu(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

/**
 * Formats a byte count as MB (or GB from 1024 MB up). Only for real
 * readings: show {@link NO_READING} when there is none.
 *
 * @param bytes - Byte count.
 * @returns e.g. `312 MB`, `1.2 GB`.
 */
export function formatMem(bytes: number): string {
	const mb = bytes / MB;
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return `${Math.round(mb)} MB`;
}

/**
 * Formats an optional reading, or {@link NO_READING} when there is none.
 *
 * @param value - The reading, if known.
 * @param format - {@link formatCpu} or {@link formatMem}.
 * @returns The formatted reading or `—`.
 */
export function formatReading(
	value: number | undefined,
	format: (value: number) => string,
): string {
	return value === undefined ? NO_READING : format(value);
}

/**
 * Short uptime since an ISO instant: `42s`, `5m`, `3h`, `2d`.
 *
 * @param startedAt - ISO-8601 start time.
 * @param now - Current time in ms (injectable for tests).
 * @returns The uptime, or `—` when unknown.
 */
export function formatUptime(
	startedAt: string | undefined,
	now: number = Date.now(),
): string {
	if (!startedAt) return "—";
	const started = Date.parse(startedAt);
	if (Number.isNaN(started)) return "—";
	const seconds = Math.max(0, Math.floor((now - started) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * `1 service` / `3 services`.
 *
 * @param count - Quantity.
 * @param singular - Singular noun.
 * @param plural - Plural noun (defaults to `singular + "s"`).
 * @returns The phrase.
 */
export function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * `HH:MM:SS` of an ISO instant in local time.
 *
 * @param iso - ISO-8601 instant.
 * @returns The time, or an empty string when absent/invalid.
 */
export function formatClock(iso: string | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toTimeString().slice(0, 8);
}

/**
 * First letter of a name, upper-cased (project avatars).
 *
 * @param name - Project name.
 * @returns The initial.
 */
export function initialOf(name: string): string {
	return (name[0] ?? "?").toUpperCase();
}
