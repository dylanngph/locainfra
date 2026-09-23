import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";

/** Line that opens the LocaInfra-managed block in a linked env file. */
export const LINK_START_MARKER = "# locainfra:start";
/** Line that closes the LocaInfra-managed block in a linked env file. */
export const LINK_END_MARKER = "# locainfra:end";

interface MarkerSpan {
	readonly start: number;
	readonly end: number;
}

function splitLines(content: string): { lines: string[]; eol: string } {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	return { lines: content.split(/\r?\n/), eol };
}

function findSpan(lines: readonly string[]): Result<MarkerSpan | null> {
	const starts: number[] = [];
	const ends: number[] = [];
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed === LINK_START_MARKER) starts.push(index);
		else if (trimmed === LINK_END_MARKER) ends.push(index);
	});
	if (starts.length === 0 && ends.length === 0) return ok(null);
	const [start] = starts;
	const [end] = ends;
	if (
		starts.length !== 1 ||
		ends.length !== 1 ||
		start === undefined ||
		end === undefined ||
		end < start
	) {
		return err(
			new OpError(
				"IO",
				`Env file has unbalanced "${LINK_START_MARKER}" / "${LINK_END_MARKER}" markers`,
				{
					details: {
						starts: starts.map((i) => i + 1),
						ends: ends.map((i) => i + 1),
						fix: "Keep exactly one start and one end marker (or delete both) and link again.",
					},
				},
			),
		);
	}
	return ok({ start, end });
}

function bodyLines(body: string): string[] {
	const trimmed = body.replace(/\r?\n$/, "");
	return trimmed === "" ? [] : trimmed.split(/\r?\n/);
}

/**
 * Replaces (or appends) the block between {@link LINK_START_MARKER} and
 * {@link LINK_END_MARKER}, preserving every other line of the file verbatim.
 *
 * @param existing - Current file contents, or `null` when the file does not exist.
 * @param body - New block contents (e.g. dotenv lines), without markers.
 * @returns The new file contents, or an `IO` error when the markers are malformed.
 */
export function writeMarkerBlock(
	existing: string | null,
	body: string,
): Result<string> {
	const block = [LINK_START_MARKER, ...bodyLines(body), LINK_END_MARKER];
	if (existing === null || existing === "") return ok(`${block.join("\n")}\n`);

	const { lines, eol } = splitLines(existing);
	const span = findSpan(lines);
	if (!span.ok) return span;

	if (span.value === null) {
		const endsWithNewline = existing.endsWith("\n");
		const lastLine = endsWithNewline ? lines.at(-2) : lines.at(-1);
		const separator =
			(endsWithNewline ? "" : eol) + (lastLine?.trim() === "" ? "" : eol);
		return ok(`${existing}${separator}${block.join(eol)}${eol}`);
	}

	const { start, end } = span.value;
	const next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
	return ok(next.join(eol));
}

/**
 * Extracts the lines between the markers.
 *
 * @param content - File contents.
 * @returns The block body (lines joined with `\n`, trailing newline included when
 *   non-empty), `null` when there is no block, or an `IO` error when the markers are malformed.
 */
export function readMarkerBlock(content: string): Result<string | null> {
	const { lines } = splitLines(content);
	const span = findSpan(lines);
	if (!span.ok) return span;
	if (span.value === null) return ok(null);
	const inner = lines.slice(span.value.start + 1, span.value.end);
	return ok(inner.length === 0 ? "" : `${inner.join("\n")}\n`);
}
