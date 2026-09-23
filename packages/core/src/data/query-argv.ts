import {
	DATA_OBJECT_PLACEHOLDER,
	DATA_QUERY_PLACEHOLDER,
	type ServiceDataKind,
} from "../catalog/catalog.model";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import { renderTemplate, renderTemplateList } from "../template/template";
import type { TemplateContext } from "../template/template.model";

function invalid(message: string, fix: string): Result<never> {
	return err(new OpError("INVALID_INPUT", message, { details: { fix } }));
}

const HEX = /^[0-9A-Fa-f]{2}$/;

const ESCAPES: Readonly<Record<string, string>> = {
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	a: "\x07",
};

/**
 * Splits a Redis command line into argv words like `redis-cli` does
 * (`sdssplitargs`): whitespace separates words; `"…"` groups a word and
 * understands `\n \r \t \b \a \\ \" \xHH`; `'…'` groups a word and only
 * understands `\'`. A closing quote must be followed by whitespace or the
 * end. The words are passed as separate argv items: nothing is ever handed
 * to a shell.
 *
 * @param line - The command line typed in the Data tab.
 * @returns The words, or `INVALID_INPUT` for unbalanced quotes.
 */
export function splitRedisWords(line: string): Result<string[]> {
	const words: string[] = [];
	let i = 0;
	const n = line.length;
	const isSpace = (c: string | undefined) =>
		c === " " ||
		c === "\n" ||
		c === "\r" ||
		c === "\t" ||
		c === "\f" ||
		c === "\v";
	while (i < n) {
		while (i < n && isSpace(line[i])) i++;
		if (i >= n) break;
		let word = "";
		let quote: '"' | "'" | null = null;
		let done = false;
		while (!done) {
			const c = line[i];
			if (quote === '"') {
				if (c === undefined) return unbalanced();
				if (
					c === "\\" &&
					line[i + 1] === "x" &&
					HEX.test(line.slice(i + 2, i + 4))
				) {
					word += String.fromCharCode(
						Number.parseInt(line.slice(i + 2, i + 4), 16),
					);
					i += 4;
					continue;
				}
				if (c === "\\" && i + 1 < n) {
					const next = line[i + 1] ?? "";
					word += ESCAPES[next] ?? next;
					i += 2;
					continue;
				}
				if (c === '"') {
					if (i + 1 < n && !isSpace(line[i + 1])) return unbalanced();
					done = true;
					i++;
					continue;
				}
				word += c;
				i++;
				continue;
			}
			if (quote === "'") {
				if (c === undefined) return unbalanced();
				if (c === "\\" && line[i + 1] === "'") {
					word += "'";
					i += 2;
					continue;
				}
				if (c === "'") {
					if (i + 1 < n && !isSpace(line[i + 1])) return unbalanced();
					done = true;
					i++;
					continue;
				}
				word += c;
				i++;
				continue;
			}
			if (c === undefined || isSpace(c)) {
				done = true;
				continue;
			}
			if (c === '"' || c === "'") {
				quote = c;
				i++;
				continue;
			}
			word += c;
			i++;
		}
		words.push(word);
	}
	return ok(words);
}

function unbalanced(): Result<never> {
	return invalid(
		"Unbalanced quotes in the command.",
		"Close every \"…\" or '…' and put a space after the closing quote.",
	);
}

/**
 * Builds the `docker exec` argv of a query from the catalog's
 * `data.runQuery` template. The argv item that is exactly `{{query}}` is
 * replaced by the query (kind `sql`: as ONE item, verbatim; kind `redis`:
 * by its words, see {@link splitRedisWords}); every other item is rendered
 * as a catalog template. The query itself is never template-rendered,
 * never parsed by a shell and never concatenated into another item.
 *
 * @param template - The catalog's `data.runQuery` argv.
 * @param kind - The Data tab kind (`sql` or `redis`).
 * @param query - The user's query text.
 * @param context - Template context of the service (holds secrets).
 * @returns The argv, or `INVALID_INPUT` (unbalanced quotes, a redis
 *   command starting with `-`, which `redis-cli` would read as an option)
 *   / `INVALID_CATALOG` (no `{{query}}` item, or a template that does not
 *   resolve).
 */
export function buildQueryArgv(
	template: readonly string[],
	kind: Exclude<ServiceDataKind, "none">,
	query: string,
	context: TemplateContext,
): Result<string[]> {
	const at = template.indexOf(DATA_QUERY_PLACEHOLDER);
	if (at === -1 || template.lastIndexOf(DATA_QUERY_PLACEHOLDER) !== at) {
		return err(
			new OpError(
				"INVALID_CATALOG",
				`data.runQuery must contain exactly one "${DATA_QUERY_PLACEHOLDER}" item`,
				{ details: { fix: "Fix the catalog definition's data.runQuery." } },
			),
		);
	}
	let words: string[];
	if (kind === "sql") {
		words = [query];
	} else {
		const split = splitRedisWords(query);
		if (!split.ok) return split;
		words = split.value;
		if (words.length === 0) {
			return invalid("Query is empty.", "Type a command, e.g. SCAN 0.");
		}
		if (words[0]?.startsWith("-")) {
			return invalid(
				`"${words[0]}" is not a Redis command.`,
				"Start the line with a command name, e.g. GET key.",
			);
		}
	}
	const before = renderArgv(template.slice(0, at), context);
	if (!before.ok) return before;
	const after = renderArgv(template.slice(at + 1), context);
	if (!after.ok) return after;
	return ok([...before.value, ...words, ...after.value]);
}

/**
 * Renders a catalog argv template (e.g. `data.listObjects`, `seed.run`).
 *
 * @param template - Argv items (templates).
 * @param context - Template context of the service (holds secrets).
 * @returns The argv, or `INVALID_CATALOG` naming the unresolved paths.
 */
export function renderArgv(
	template: readonly string[],
	context: TemplateContext,
): Result<string[]> {
	try {
		return ok(renderTemplateList(template, context));
	} catch (cause) {
		return err(
			new OpError(
				"INVALID_CATALOG",
				cause instanceof Error ? cause.message : "Unresolved catalog template",
				{
					cause,
					details: {
						fix: "Fix the catalog definition (catalog override or registry entry).",
					},
				},
			),
		);
	}
}

/**
 * Fills the catalog's `data.defaultQuery` for one object: `{{object}}`
 * becomes the object name (inserted literally, never re-evaluated); other
 * `{{path}}` placeholders render from the service context.
 *
 * @param template - The catalog's `data.defaultQuery`.
 * @param object - Object name (table, key pattern…).
 * @param context - Template context of the service.
 * @returns The query text, or `INVALID_CATALOG`.
 */
export function renderDefaultQuery(
	template: string,
	object: string,
	context: TemplateContext,
): Result<string> {
	const parts = template.split(DATA_OBJECT_PLACEHOLDER);
	const rendered: string[] = [];
	for (const part of parts) {
		try {
			rendered.push(renderTemplate(part, context));
		} catch (cause) {
			return err(
				new OpError(
					"INVALID_CATALOG",
					cause instanceof Error
						? cause.message
						: "Unresolved catalog template",
					{
						cause,
						details: { fix: "Fix the catalog definition's data.defaultQuery." },
					},
				),
			);
		}
	}
	return ok(rendered.join(object));
}
