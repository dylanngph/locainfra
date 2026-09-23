import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";

/** Tabs of the service detail page, in order. */
export const DETAIL_TABS = [
	"connect",
	"data",
	"logs",
	"metrics",
	"snapshots",
] as const;
/** A service detail tab. */
export type DetailTab = (typeof DETAIL_TABS)[number];

/** "Use in code" snippet languages. */
export const SNIPPET_LANGS = ["env", "node", "python", "go"] as const;
/** A snippet language. */
export type SnippetLang = (typeof SNIPPET_LANGS)[number];

/** `?tab=` of the service detail page (default `connect`). */
export const useDetailTab = () =>
	useQueryState(
		"tab",
		parseAsStringLiteral(DETAIL_TABS).withDefault("connect"),
	);

/** `?lang=` of the Connect tab snippets (default `.env`). */
export const useSnippetLang = () =>
	useQueryState("lang", parseAsStringLiteral(SNIPPET_LANGS).withDefault("env"));

/** `?f=` log filter. */
export const useLogFilter = () =>
	useQueryState("f", parseAsString.withDefault(""));
