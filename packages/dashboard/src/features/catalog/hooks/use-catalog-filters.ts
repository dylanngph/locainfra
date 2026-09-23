import { parseAsString, useQueryStates } from "nuqs";
import { ALL_CATEGORIES } from "../lib/filter-catalog";

/** URL state of the catalog: `?q=` search text and `?cat=` category id. */
export function useCatalogFilters() {
	return useQueryStates({
		q: parseAsString.withDefault(""),
		cat: parseAsString.withDefault(ALL_CATEGORIES),
	});
}
