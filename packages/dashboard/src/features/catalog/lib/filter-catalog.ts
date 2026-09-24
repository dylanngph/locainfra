import type { CatalogCategory, ServiceDefinition } from "@locastack/server";

/** `cat` value that shows every category. */
export const ALL_CATEGORIES = "all";

/**
 * Category slug of a definition (`categoryLabel ?? category`), matching the
 * server's `CatalogCategory.id`.
 *
 * @param definition - Catalog definition.
 * @returns e.g. `database`, `redis`.
 */
export function categoryId(definition: ServiceDefinition): string {
	const label = definition.categoryLabel ?? definition.category;
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Label of a definition's category chip.
 *
 * @param definition - Catalog definition.
 * @param categories - Server categories.
 * @returns e.g. `Database`, `Redis`.
 */
export function categoryLabel(
	definition: ServiceDefinition,
	categories: readonly CatalogCategory[],
): string {
	const id = categoryId(definition);
	return (
		categories.find((c) => c.id === id)?.label ??
		definition.categoryLabel ??
		definition.category
	);
}

/**
 * Filters catalog definitions by search text and category.
 *
 * @param definitions - All definitions.
 * @param query - Free text (name, id, category, description, tags).
 * @param category - Category id, or {@link ALL_CATEGORIES}.
 * @returns Matching definitions in catalog order.
 */
export function filterCatalog(
	definitions: readonly ServiceDefinition[],
	query: string,
	category: string,
): ServiceDefinition[] {
	const q = query.trim().toLowerCase();
	return definitions.filter((d) => {
		if (category !== ALL_CATEGORIES && categoryId(d) !== category) return false;
		if (!q) return true;
		return [
			d.name,
			d.id,
			d.category,
			d.categoryLabel ?? "",
			d.description ?? "",
			...d.tags,
		]
			.join(" ")
			.toLowerCase()
			.includes(q);
	});
}

/**
 * Concrete image of a definition at a version.
 *
 * @param definition - Catalog definition.
 * @param version - Version (defaults to `defaultVersion`).
 * @returns e.g. `postgres:17-alpine`.
 */
export function imageOf(
	definition: ServiceDefinition,
	version = definition.defaultVersion,
): string {
	return definition.image.replaceAll("{{version}}", version);
}
