import type { ResolvedService } from "../../resolve/resolved.model";
import { ok, type Result } from "../../shared/result";
import type { Stack } from "../../stack/stack.model";
import type { GetServiceDeps } from "../ops.contract";
import type { ServiceDetail, ServiceStatus } from "../ops.model";
import { readProjectView } from "./project-view";
import { findService } from "./service-input";
import { collectProjectStatus } from "./service-status";

/**
 * @param status - Live status of the service.
 * @param service - The resolved service.
 * @param network - The project network.
 * @returns The service detail (no secret values).
 */
export function toServiceDetail(
	status: ServiceStatus,
	service: ResolvedService,
	network: string,
): ServiceDetail {
	return {
		...status,
		network,
		config: { ...service.config },
		secretNames: [...service.definition.secrets],
		volumes: service.volumes.map((v) => ({
			name: v.name,
			source: v.source,
			path: v.path,
		})),
	};
}

/**
 * Details of the named services of a project (all when `only` is omitted),
 * in stack file order.
 *
 * @param deps - View and container ports.
 * @param stack - The project stack.
 * @param only - Instance name to return (`SERVICE_NOT_FOUND` when absent).
 * @returns The details, or the first error.
 */
export async function collectServiceDetails(
	deps: GetServiceDeps,
	stack: Stack,
	only?: string,
): Promise<Result<ServiceDetail[]>> {
	if (only !== undefined) {
		const found = findService(stack, only);
		if (!found.ok) return found;
	}
	const view = await readProjectView(deps, stack, "placeholder");
	if (!view.ok) return view;
	const order = Object.keys(stack.file.services).filter(
		(name) => only === undefined || name === only,
	);
	const status = await collectProjectStatus(deps, view.value, order);
	if (!status.ok) return status;
	const byName = new Map(view.value.resolved.services.map((s) => [s.name, s]));
	const details: ServiceDetail[] = [];
	for (const service of status.value.services) {
		const resolved = byName.get(service.name);
		if (resolved === undefined) continue;
		details.push(toServiceDetail(service, resolved, status.value.network));
	}
	return ok(details);
}
