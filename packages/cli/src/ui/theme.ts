import { Ansis, reset } from "ansis";

/**
 * Color level for human output. `ansis` alone enables color whenever
 * `COLORTERM` is set, even when stdout is piped to a file, so a non-TTY
 * stdout turns color off unless `FORCE_COLOR` is set. `NO_COLOR` always wins
 * (ansis already folds it into `detected`).
 *
 * @param env - Environment (default `process.env`).
 * @param isTTY - Whether stdout is a terminal.
 * @param detected - Level ansis detected (0 = none … 3 = truecolor).
 * @returns The level to render with.
 */
export function colorLevel(
	env: Readonly<Record<string, string | undefined>> = process.env,
	isTTY: boolean = Boolean(process.stdout.isTTY),
	detected: number = reset.level,
): number {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
	if (env.FORCE_COLOR !== undefined) return detected;
	return isTTY ? detected : 0;
}

const color = new Ansis(colorLevel());

/** Semantic color helpers; callers never branch on color support. */
export const theme = {
	/** Success text. */
	ok: (text: string): string => color.green(text),
	/** Warning text. */
	warn: (text: string): string => color.yellow(text),
	/** Failure text. */
	fail: (text: string): string => color.red(text),
	/** De-emphasised text (details, hints). */
	muted: (text: string): string => color.dim(text),
	/** Highlighted text (names, URLs). */
	accent: (text: string): string => color.cyan(text),
	/** Headings. */
	strong: (text: string): string => color.bold(text),
} as const;

/** Status glyphs used in human output. */
export const glyph = {
	/** Success. */
	ok: "✓",
	/** Warning. */
	warn: "▲",
	/** Failure. */
	fail: "✗",
	/** In-progress step. */
	step: "›",
} as const;
