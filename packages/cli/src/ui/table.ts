/** Layout options for {@link formatTable}. */
export interface TableOptions {
	/** Optional header row (rendered like any other row). */
	readonly header?: readonly string[];
	/** Spaces between columns. Defaults to 2. */
	readonly gap?: number;
	/** Spaces before every row. Defaults to 0. */
	readonly indent?: number;
}

/**
 * Pads `text` with spaces to a visible width, ignoring ANSI escapes and
 * counting wide (CJK, emoji) characters correctly via `Bun.stringWidth`.
 *
 * @param text - Possibly colored text.
 * @param width - Target visible width.
 * @returns `text` followed by enough spaces to reach `width`.
 */
export function padVisible(text: string, width: number): string {
	const missing = width - Bun.stringWidth(text);
	return missing > 0 ? text + " ".repeat(missing) : text;
}

/**
 * Formats rows as aligned columns. The last column is never padded, so lines
 * carry no trailing whitespace. Rows may have different lengths.
 *
 * @param rows - Cell text per row (may contain ANSI colors).
 * @param options - Header, gap and indent.
 * @returns The table as lines joined by `\n` (no trailing newline); empty string for no rows.
 */
export function formatTable(
	rows: readonly (readonly string[])[],
	options: TableOptions = {},
): string {
	const all = options.header ? [options.header, ...rows] : [...rows];
	if (all.length === 0) return "";
	const gap = " ".repeat(options.gap ?? 2);
	const indent = " ".repeat(options.indent ?? 0);
	const widths: number[] = [];
	for (const row of all) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, Bun.stringWidth(cell));
		});
	}
	return all
		.map((row) => {
			const cells = row.map((cell, i) =>
				i === row.length - 1 ? cell : padVisible(cell, widths[i] ?? 0),
			);
			return (indent + cells.join(gap)).trimEnd();
		})
		.join("\n");
}
