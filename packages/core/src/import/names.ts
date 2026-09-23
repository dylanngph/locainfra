import { NAME_PATTERN } from "../stack/stack.model";

const NAME = new RegExp(NAME_PATTERN);

/** Prefix of a derived name whose source does not start with a letter. */
export const NAME_PREFIX = "svc";

/**
 * Derives a project or service instance name (`^[a-z][a-z0-9-]*$`) from free
 * text such as a compose service key: lower-cased, every other character
 * becomes `-` (runs collapsed, trimmed), prefixed with `svc-` when it does
 * not start with a letter.
 *
 * @param text - Source text, e.g. `My_DB` or `1cache`.
 * @param prefix - Prefix used when the slug does not start with a letter.
 * @returns A valid name, e.g. `my-db` or `svc-1cache`.
 */
export function slugName(text: string, prefix = NAME_PREFIX): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug === "") return prefix;
	return NAME.test(slug) ? slug : `${prefix}-${slug}`;
}

/**
 * @param base - A valid name.
 * @param taken - Names already used.
 * @returns `base`, else `base-2`, `base-3`, … whichever is free.
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}
