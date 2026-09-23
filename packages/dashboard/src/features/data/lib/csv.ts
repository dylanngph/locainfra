const needsQuotes = /[",\r\n]|^\s|\s$/;

/**
 * Quotes one CSV cell when needed (RFC 4180: `"` doubled).
 *
 * @param cell - Cell text.
 * @returns The encoded cell.
 */
export function csvCell(cell: string): string {
	return needsQuotes.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Serialises a result grid as CSV (header row first, CRLF line ends).
 *
 * @param columns - Header cells.
 * @param rows - Data rows.
 * @returns The CSV text.
 */
export function toCsv(
	columns: readonly string[],
	rows: readonly (readonly string[])[],
): string {
	return [columns, ...rows]
		.map((row) => row.map(csvCell).join(","))
		.join("\r\n")
		.concat("\r\n");
}

/**
 * File name of an export: the selected object (or the service) with
 * characters that are awkward in file names replaced.
 *
 * @param base - Object or service name, e.g. `users` or `*`.
 * @param fallback - Used when `base` has no usable character.
 * @returns e.g. `users.csv`.
 */
export function csvFileName(
	base: string | undefined,
	fallback: string,
): string {
	const clean = (base ?? "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+|-+$/g, "");
	return `${clean || fallback}.csv`;
}
