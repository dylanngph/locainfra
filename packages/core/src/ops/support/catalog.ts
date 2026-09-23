import type { ServiceDefinition } from "../../catalog/catalog.model";
import type { CatalogSource } from "../../catalog/catalog.source";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";

/**
 * Loads the merged catalog, turning a rejection into `INVALID_CATALOG`.
 *
 * @param catalog - Catalog source.
 * @returns Every definition, or `INVALID_CATALOG`.
 */
export async function loadDefinitions(
	catalog: CatalogSource,
): Promise<Result<ServiceDefinition[]>> {
	try {
		return ok(await catalog.definitions());
	} catch (cause) {
		return err(
			new OpError("INVALID_CATALOG", "Could not load the service catalog", {
				cause,
				details: cause instanceof Error ? { reason: cause.message } : undefined,
			}),
		);
	}
}
