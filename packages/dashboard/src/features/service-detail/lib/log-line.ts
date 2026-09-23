import Anser from "anser";

/** Level shown in the log pane's second column. */
export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "LOG";

const LEVELS: readonly [RegExp, LogLevel][] = [
	[/\b(ERROR|ERR|FATAL|PANIC|CRITICAL)\b/i, "ERROR"],
	[/\b(WARN|WARNING)\b/i, "WARN"],
	[/\bDEBUG\b/i, "DEBUG"],
	[/\b(INFO|NOTICE)\b/i, "INFO"],
	[/\bLOG\b/, "LOG"],
];

/**
 * Best-effort level of a log line from its text (stderr alone is not an
 * error: Postgres, for one, logs everything there).
 *
 * @param text - Line text (ANSI allowed).
 * @returns The detected level, `INFO` by default.
 */
export function detectLevel(text: string): LogLevel {
	const plain = Anser.ansiToText(text).slice(0, 160);
	for (const [pattern, level] of LEVELS) if (pattern.test(plain)) return level;
	return "INFO";
}

// Leading timestamps a container prints itself (the pane already shows the
// arrival time): ISO-8601 / Postgres `2026-09-23 06:59:05.152 UTC`, optionally
// bracketed, and Redis `1:M 23 Sep 2026 06:59:05.152 * `.
const ISO_STAMP =
	/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?: ?(?:Z|UTC|GMT|[A-Z]{3,4}|[+-]\d{2}:?\d{2}))?\]?\s+/;
const REDIS_STAMP =
	/^\d+:[XCSM] \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2}\.\d{3} ([.\-*#]) /;
const PID = /^\[\d+\]\s*/;
const PREFIX =
	/^\[?(ERROR|FATAL|PANIC|CRITICAL|WARNING|WARN|NOTICE|INFO|DEBUG\d?|LOG|DETAIL|HINT|STATEMENT|CONTEXT)(?:\]:?|:)\s*/;

const PREFIX_LEVEL: Readonly<Record<string, LogLevel>> = {
	ERROR: "ERROR",
	FATAL: "ERROR",
	PANIC: "ERROR",
	CRITICAL: "ERROR",
	WARNING: "WARN",
	WARN: "WARN",
	NOTICE: "INFO",
	INFO: "INFO",
};

const prefixLevel = (word: string): LogLevel =>
	PREFIX_LEVEL[word] ?? (word.startsWith("DEBUG") ? "DEBUG" : "LOG");

/** A log line split for the pane's `time LEVEL message` columns. */
export interface ParsedLogLine {
	/** `null` for a blank line (the pane collapses those). */
	readonly level: LogLevel | null;
	/** Text without the container's own timestamp, pid and `LEVEL:` prefix. */
	readonly message: string;
	/** `message` without ANSI codes (tooltips, copy). */
	readonly plain: string;
}

/**
 * Splits a raw container line into level and message: strips a leading
 * ISO/Postgres/Redis timestamp, a `[pid]`, and a `LEVEL:` prefix (using it as
 * the level), so rows read `13:59:05  LOG  database system is ready`.
 * Lines that start with ANSI codes are left intact.
 *
 * @param text - Raw line (ANSI allowed).
 * @returns Level and cleaned message.
 */
export function parseLogLine(text: string): ParsedLogLine {
	if (Anser.ansiToText(text).trim() === "")
		return { level: null, message: "", plain: "" };
	let rest = text;
	let level: LogLevel | undefined;
	const redis = REDIS_STAMP.exec(rest);
	if (redis) {
		rest = rest.slice(redis[0].length);
		level = redis[1] === "#" ? "WARN" : redis[1] === "." ? "DEBUG" : "INFO";
	} else {
		const iso = ISO_STAMP.exec(rest);
		if (iso) rest = rest.slice(iso[0].length).replace(PID, "");
	}
	const prefix = PREFIX.exec(rest);
	if (prefix?.[1]) {
		rest = rest.slice(prefix[0].length);
		level = prefixLevel(prefix[1]);
	}
	return {
		level: level ?? detectLevel(rest),
		message: rest,
		plain: Anser.ansiToText(rest),
	};
}

/** A styled fragment of a log line. */
export interface AnsiSpan {
	readonly text: string;
	/** CSS color (`rgb(r, g, b)`) or `undefined` for the default. */
	readonly color?: string;
	readonly bold: boolean;
}

/**
 * Splits a line with ANSI SGR codes into styled spans.
 *
 * @param text - Raw line.
 * @returns Spans in order.
 */
export function ansiSpans(text: string): AnsiSpan[] {
	if (!text.includes("\u001b[")) return [{ text, bold: false }];
	return Anser.ansiToJson(text, { json: true, remove_empty: true }).map(
		(entry) => ({
			text: entry.content,
			color: entry.fg ? `rgb(${entry.fg})` : undefined,
			bold: entry.decorations.includes("bold"),
		}),
	);
}

/**
 * Case-insensitive filter on the plain text.
 *
 * @param text - Raw line.
 * @param filter - Filter text.
 * @returns Whether the line matches.
 */
export function matchesFilter(text: string, filter: string): boolean {
	if (!filter) return true;
	return Anser.ansiToText(text).toLowerCase().includes(filter.toLowerCase());
}
