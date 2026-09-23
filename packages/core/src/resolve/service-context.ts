import type {
	TemplateContext,
	TemplateServiceContext,
} from "../template/template.model";
import type { ResolvedService, ResolvedStack } from "./resolved.model";

/**
 * Rebuilds the template context a resolved service was rendered with (the
 * same roots as the resolver: `name`, `version`, `port`, `stack.name`,
 * `config.*`, `secrets.*`, and each dependency as `services.<catalogId>`,
 * `services.<instance>` and `byType.<catalogId>`). Used to render the
 * catalog's `data` and `seed` argv templates of a running service.
 *
 * @param stack - The resolved stack.
 * @param service - One of its services.
 * @returns The context (holds secrets; never log it).
 */
export function serviceTemplateContext(
	stack: ResolvedStack,
	service: ResolvedService,
): TemplateContext {
	const byName = new Map(stack.services.map((s) => [s.name, s]));
	const byType: Record<string, TemplateServiceContext> = {};
	const byInstance: Record<string, TemplateServiceContext> = {};
	for (const dep of service.dependsOn) {
		const target = byName.get(dep);
		if (target === undefined) continue;
		const context: TemplateServiceContext = {
			host: target.name,
			port: target.hostPort,
			secrets: target.secrets,
			config: target.config,
		};
		byType[target.type] = context;
		byInstance[target.name] = context;
	}
	return {
		name: service.name,
		version: service.version,
		port: service.hostPort,
		stack: { name: stack.name },
		config: service.config,
		secrets: service.secrets,
		// Catalog-id keys win, as in the resolver.
		services: { ...byInstance, ...byType },
		byType,
	};
}
