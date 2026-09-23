import type {
	TemplateContext,
	TemplateIssue,
	TemplateIssueReason,
} from "./template.model";
import { TemplateError } from "./template.model";

/**
 * Matches one `{{ path }}` placeholder. The body may not contain braces, so an
 * unmatched `{{` is left as literal text.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** A valid path: dot-separated segments of letters, digits, `_` and `-`. */
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

type Lookup =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly reason: TemplateIssueReason };

function lookup(context: unknown, path: string): Lookup {
	if (path === "" || !PATH.test(path)) {
		return { ok: false, reason: path === "" ? "empty" : "unknown" };
	}
	let current: unknown = context;
	for (const segment of path.split(".")) {
		if (
			current === null ||
			typeof current !== "object" ||
			!Object.hasOwn(current, segment)
		) {
			return { ok: false, reason: "unknown" };
		}
		current = (current as Record<string, unknown>)[segment];
	}
	if (typeof current === "string") return { ok: true, value: current };
	if (typeof current === "number" && Number.isFinite(current)) {
		return { ok: true, value: String(current) };
	}
	if (current === undefined) return { ok: false, reason: "unknown" };
	return { ok: false, reason: "not-scalar" };
}

/**
 * Lists the paths referenced by a template, in order, without duplicates.
 *
 * @param template - Template text, e.g. `postgres://{{config.USER}}@127.0.0.1:{{port}}`.
 * @returns Trimmed paths, e.g. `["config.USER", "port"]`.
 */
export function templatePaths(template: string): string[] {
	const seen = new Set<string>();
	for (const match of template.matchAll(PLACEHOLDER)) {
		seen.add((match[1] ?? "").trim());
	}
	return [...seen];
}

/**
 * Substitutes every `{{path}}` placeholder in `template` from `context`.
 *
 * Logic-free by design: no conditionals, filters or evaluation. Substitution is
 * a single pass, so values containing `{{…}}` are inserted literally. Only own
 * properties are looked up (`{{config.constructor}}` is unknown), and a path
 * must end at a string or finite number.
 *
 * @param template - Template text.
 * @param context - Values available to the template.
 * @returns The rendered string.
 * @throws {@link TemplateError} listing every path that could not be resolved.
 */
export function renderTemplate(
	template: string,
	context: TemplateContext,
): string {
	const issues: TemplateIssue[] = [];
	const rendered = template.replace(PLACEHOLDER, (whole, body: string) => {
		const path = body.trim();
		const found = lookup(context, path);
		if (found.ok) return found.value;
		if (!issues.some((issue) => issue.path === path)) {
			issues.push({ path, reason: found.reason });
		}
		return whole;
	});
	if (issues.length > 0) throw new TemplateError(issues);
	return rendered;
}

/**
 * Renders every value of a string record (e.g. a definition's `env` or `exports`).
 *
 * @param templates - Name → template.
 * @param context - Values available to the templates.
 * @returns Name → rendered value, same key order.
 * @throws {@link TemplateError} listing every unresolved path across all values.
 */
export function renderTemplateRecord(
	templates: Readonly<Record<string, string>>,
	context: TemplateContext,
): Record<string, string> {
	return collect(Object.entries(templates), context, (entries) =>
		Object.fromEntries(entries),
	);
}

/**
 * Renders every item of a string list (e.g. a healthcheck `test` or `command`).
 *
 * @param templates - Templates.
 * @param context - Values available to the templates.
 * @returns Rendered items, same order.
 * @throws {@link TemplateError} listing every unresolved path across all items.
 */
export function renderTemplateList(
	templates: readonly string[],
	context: TemplateContext,
): string[] {
	return collect(
		templates.map((template, index) => [String(index), template] as const),
		context,
		(entries) => entries.map(([, value]) => value),
	);
}

function collect<T>(
	entries: ReadonlyArray<readonly [string, string]>,
	context: TemplateContext,
	build: (rendered: Array<[string, string]>) => T,
): T {
	const issues: TemplateIssue[] = [];
	const rendered: Array<[string, string]> = [];
	for (const [key, template] of entries) {
		try {
			rendered.push([key, renderTemplate(template, context)]);
		} catch (error) {
			if (!(error instanceof TemplateError)) throw error;
			for (const issue of error.issues) {
				if (!issues.some((known) => known.path === issue.path)) {
					issues.push(issue);
				}
			}
		}
	}
	if (issues.length > 0) throw new TemplateError(issues);
	return build(rendered);
}
