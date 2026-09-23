import { stringify } from "yaml";
import { dotenvFormatter } from "../env/formats/dotenv";
import type { ResolvedService, ResolvedStack } from "../resolve/resolved.model";
import {
	LABEL_CATALOG_ID,
	LABEL_SERVICE,
	LABEL_STACK,
	LABEL_VERSION,
} from "./labels";
import {
	type ComposeEscaper,
	collectStackSecrets,
	createComposeEscaper,
	secretVarName,
} from "./secret-refs";

/** Compose `healthcheck` block. */
export interface ComposeHealthcheck {
	/** Test command. */
	test: string[];
	/** Duration between checks. */
	interval?: string;
	/** Check timeout. */
	timeout?: string;
	/** Failures before unhealthy. */
	retries?: number;
	/** Start grace period. */
	start_period?: string;
}

/** Compose `depends_on` entry. */
export interface ComposeDependency {
	/** When the dependency counts as ready. */
	condition: "service_started" | "service_healthy";
}

/** One compose service as rendered by LocaInfra. */
export interface ComposeService {
	/** Image reference. */
	image: string;
	/** Container name, `li-<stack>-<service>`. */
	container_name: string;
	/** Always `unless-stopped`. */
	restart: "unless-stopped";
	/** Command override. */
	command?: string[];
	/** Container environment (secrets as `${LI_SECRET_*}` references). */
	environment?: Record<string, string>;
	/** `127.0.0.1:<host>:<container>` bindings. */
	ports: string[];
	/** `<volume>:<path>` mounts. */
	volumes?: string[];
	/** Healthcheck. */
	healthcheck?: ComposeHealthcheck;
	/** Start-order dependencies. */
	depends_on?: Record<string, ComposeDependency>;
	/** `locainfra.*` labels. */
	labels: Record<string, string>;
	/** The stack network. */
	networks: string[];
}

/** A top-level named volume or network. */
export interface ComposeNamedResource {
	/** Exact Docker name (no project prefix). */
	name: string;
	/** `locainfra.*` labels. */
	labels: Record<string, string>;
}

/** The compose document LocaInfra renders for a stack. */
export interface ComposeDocument {
	/** Compose project name, `li-<stack>`. */
	name: string;
	/** Services by compose service key. */
	services: Record<string, ComposeService>;
	/** Named volumes. */
	volumes?: Record<string, ComposeNamedResource>;
	/** The stack network. */
	networks: Record<string, ComposeNamedResource>;
}

/**
 * @param stack - Stack name.
 * @param service - Service key.
 * @returns The container name, `li-<stack>-<service>`.
 */
export function containerName(stack: string, service: string): string {
	return `li-${stack}-${service}`;
}

function renderService(
	stack: ResolvedStack,
	service: ResolvedService,
	byId: ReadonlyMap<string, ResolvedService>,
	escaper: ComposeEscaper,
): ComposeService {
	const environment = Object.fromEntries(
		Object.entries(service.env).map(([k, v]) => [k, escaper.escape(v)]),
	);
	const dependsOn = Object.fromEntries(
		service.dependsOn.map((dep): [string, ComposeDependency] => [
			dep,
			{
				condition: byId.get(dep)?.healthcheck
					? "service_healthy"
					: "service_started",
			},
		]),
	);
	const hc = service.healthcheck;
	return {
		image: service.image,
		container_name: containerName(stack.name, service.id),
		restart: "unless-stopped",
		...(service.command && {
			command: service.command.map((part) => escaper.escape(part)),
		}),
		...(Object.keys(environment).length > 0 && { environment }),
		ports: [`127.0.0.1:${service.hostPort}:${service.containerPort}`],
		...(service.volumes.length > 0 && {
			volumes: service.volumes.map((v) => `${v.name}:${v.path}`),
		}),
		...(hc && {
			healthcheck: {
				test: hc.test.map((part) => escaper.escape(part)),
				...(hc.interval !== undefined && { interval: hc.interval }),
				...(hc.timeout !== undefined && { timeout: hc.timeout }),
				...(hc.retries !== undefined && { retries: hc.retries }),
				...(hc.startPeriod !== undefined && { start_period: hc.startPeriod }),
			},
		}),
		...(service.dependsOn.length > 0 && { depends_on: dependsOn }),
		labels: {
			[LABEL_STACK]: stack.name,
			[LABEL_SERVICE]: service.id,
			[LABEL_CATALOG_ID]: service.catalogId,
			[LABEL_VERSION]: service.version,
		},
		networks: [stack.network],
	};
}

/**
 * Builds the compose document for a resolved stack. Ports bind to
 * 127.0.0.1 only; secret values are replaced by `${LI_SECRET_<NAME>}`
 * references resolved from the `.env` next to the compose file
 * ({@link renderComposeEnvFile}).
 *
 * @param stack - The resolved stack.
 * @returns The compose document (plain data).
 */
export function toComposeDocument(stack: ResolvedStack): ComposeDocument {
	const escaper = createComposeEscaper(collectStackSecrets(stack));
	const byId = new Map(stack.services.map((s) => [s.id, s]));
	const services: Record<string, ComposeService> = {};
	const volumes: Record<string, ComposeNamedResource> = {};

	for (const service of stack.services) {
		services[service.id] = renderService(stack, service, byId, escaper);
		for (const volume of service.volumes) {
			volumes[volume.name] = {
				name: volume.name,
				labels: { [LABEL_STACK]: stack.name, [LABEL_SERVICE]: service.id },
			};
		}
	}

	return {
		name: stack.projectName,
		services,
		...(Object.keys(volumes).length > 0 && { volumes }),
		networks: {
			[stack.network]: {
				name: stack.network,
				labels: { [LABEL_STACK]: stack.name },
			},
		},
	};
}

/**
 * Renders a resolved stack to `docker-compose.yml` text. Deterministic for a
 * given input (golden-snapshot tested) and free of secret values (unless a
 * secret is shorter than 8 characters).
 *
 * @param stack - The resolved stack.
 * @returns YAML text with a generated-file header.
 */
export function renderCompose(stack: ResolvedStack): string {
	const header = `# Generated by LocaInfra for stack "${stack.name}". Do not edit: changes are overwritten.\n# Change the stack from the dashboard or its stack file instead.\n`;
	return (
		header +
		stringify(toComposeDocument(stack), {
			lineWidth: 0,
			defaultStringType: "QUOTE_DOUBLE",
			defaultKeyType: "PLAIN",
		})
	);
}

/**
 * Renders the `.env` placed next to the compose file: one
 * `LI_SECRET_<NAME>=<value>` line per stack secret, for compose interpolation.
 * Contains secrets; write it with owner-only permissions.
 *
 * @param stack - The resolved stack.
 * @returns Dotenv text.
 */
export function renderComposeEnvFile(stack: ResolvedStack): string {
	const vars = Object.fromEntries(
		Object.entries(collectStackSecrets(stack)).map(([name, value]) => [
			secretVarName(name),
			value,
		]),
	);
	return `# Generated by LocaInfra: secrets for docker compose interpolation. Do not commit.\n${dotenvFormatter.format(vars)}`;
}
