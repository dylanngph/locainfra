import {
	OpError,
	type ServiceDefinition,
	type Stack,
	type StackServiceEntry,
} from "@locastack/core";
import type { ServerOps, ServerPorts } from "../deps";
import { unwrap } from "./unwrap";

/** A service instance as found by {@link ServiceLookup.service}. */
export interface ServiceContext {
	/** The loaded project stack. */
	readonly stack: Stack;
	/** The instance's `locastack.yaml` entry. */
	readonly entry: StackServiceEntry;
	/** Its catalog definition; `undefined` when the type is not in the catalog (the op reports it). */
	readonly definition: ServiceDefinition | undefined;
}

/**
 * Cheap pre-checks shared by the services that answer `202`: load the
 * project, find the entry and its catalog definition, so a missing project
 * or service is a `404` before any operation starts.
 */
export class ServiceLookup {
	/**
	 * @param ops - `loadProject`.
	 * @param ports - Ports passed to it (and the catalog).
	 */
	constructor(
		private readonly ops: Pick<ServerOps, "loadProject">,
		private readonly ports: ServerPorts,
	) {}

	/**
	 * @param project - Project name.
	 * @returns The loaded stack.
	 * @throws OpError `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`, `INVALID_STACK`.
	 */
	async stack(project: string): Promise<Stack> {
		return unwrap(await this.ops.loadProject(this.ports, { project }));
	}

	/**
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @returns The stack, the entry and its definition.
	 * @throws OpError as {@link ServiceLookup.stack}, `SERVICE_NOT_FOUND`.
	 */
	async service(project: string, name: string): Promise<ServiceContext> {
		const stack = await this.stack(project);
		const entry = stack.file.services[name];
		if (entry === undefined)
			throw new OpError(
				"SERVICE_NOT_FOUND",
				`No service named ${name} in ${project}`,
			);
		return { stack, entry, definition: await this.definition(entry.type) };
	}

	/**
	 * @param type - Catalog id.
	 * @returns The merged catalog's definition, if any.
	 */
	async definition(type: string): Promise<ServiceDefinition | undefined> {
		const definitions = await this.ports.catalog.definitions();
		return definitions.find((d) => d.id === type);
	}
}
