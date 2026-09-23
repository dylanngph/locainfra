import type { ServiceDefinition } from "./catalog.model";

/**
 * Supplies the merged, validated catalog (built-ins → registry cache → user
 * overrides; later wins by `id`).
 */
export interface CatalogSource {
	/** @returns Every available service definition, one per `id`. */
	definitions(): Promise<ServiceDefinition[]>;
}
