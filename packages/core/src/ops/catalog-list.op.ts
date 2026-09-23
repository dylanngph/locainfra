import { ok } from "../shared/result";
import type { CatalogList } from "./ops.contract";
import type { CatalogCategory } from "./ops.model";
import { loadDefinitions } from "./support/catalog";

/**
 * @param text - A label, e.g. `Object storage`.
 * @returns Its URL slug, e.g. `object-storage`.
 */
export function categorySlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function titleCase(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Every catalog definition sorted by name, plus one filter category per
 * distinct `categoryLabel ?? category` (label title-cased, id slugged) with
 * its definition count, in first-appearance order of the sorted list.
 *
 * @returns The listing, or `INVALID_CATALOG`.
 */
export const catalogList: CatalogList = async (deps) => {
	const loaded = await loadDefinitions(deps.catalog);
	if (!loaded.ok) return loaded;
	const definitions = [...loaded.value].sort(
		(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
	);
	const categories = new Map<string, CatalogCategory>();
	for (const definition of definitions) {
		const label = definition.categoryLabel ?? titleCase(definition.category);
		const id = categorySlug(label);
		const current = categories.get(id);
		categories.set(
			id,
			current === undefined
				? { id, label, category: definition.category, count: 1 }
				: { ...current, count: current.count + 1 },
		);
	}
	return ok({ definitions, categories: [...categories.values()] });
};
