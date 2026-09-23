import {
	type CatalogList,
	type CatalogListDeps,
	type CatalogListing,
	OpError,
	type PortProbe,
	type StateReader,
	suggestFreePort,
} from "@locainfra/core";
import { unwrap } from "../../shared/unwrap";
import type { FreePort } from "./catalog.model";

/** Ports of {@link CatalogService}: the catalog plus what port suggestions need. */
export type CatalogServiceDeps = CatalogListDeps & {
	/** Pinned ports of every project. */
	readonly state: StateReader;
	/** 127.0.0.1 bind probe. */
	readonly probe: PortProbe;
};

/** Catalog definitions, filter categories and free-port suggestions. No HTTP knowledge. */
export class CatalogService {
	/**
	 * @param catalogList - Core op.
	 * @param deps - Its ports plus state and the port probe.
	 */
	constructor(
		private readonly catalogList: CatalogList,
		private readonly deps: CatalogServiceDeps,
	) {}

	/**
	 * @returns The listing.
	 * @throws OpError `INVALID_CATALOG` when the catalog fails to load.
	 */
	async list(): Promise<CatalogListing> {
		return unwrap(await this.catalogList(this.deps));
	}

	/**
	 * The host port the Config screen proposes for a new instance of `type`:
	 * same rule as `port: auto` and "Use port N" (definition range, skipping
	 * the canonical default and every pinned port, bind-probed on 127.0.0.1).
	 *
	 * @param type - Catalog id.
	 * @returns The port, or `null` when none is free.
	 * @throws OpError `INVALID_INPUT` for an unknown type.
	 */
	async freePort(type: string): Promise<FreePort> {
		const definitions = await this.deps.catalog.definitions();
		const definition = definitions.find((d) => d.id === type);
		if (definition === undefined)
			throw new OpError("INVALID_INPUT", `Unknown service type ${type}`, {
				details: { field: "type" },
			});
		const state = await this.deps.state.read();
		const port = await suggestFreePort(this.deps.probe, state, definition);
		return { port: port ?? null };
	}
}
