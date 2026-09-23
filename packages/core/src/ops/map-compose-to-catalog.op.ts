import type { ServiceDefinition } from "../catalog/catalog.model";
import { parseImageRef, versionFromTag } from "../import/image-ref";
import { interpolateDefaults } from "../import/interpolation";
import { slugName, uniqueName } from "../import/names";
import type { PortProbe } from "../ports/files.port";
import { portsInRange } from "../resolve/ports/ranges";
import type { MapComposeInput, MapComposeToCatalog } from "./ops.contract";
import {
	type ComposeImportService,
	IMPORT_SECRET_VALUE_PATTERN,
	type ImportItem,
} from "./ops.model";
import { MAX_SUGGESTION_PROBES } from "./support/ports";

const IMPORT_SECRET_VALUE = new RegExp(IMPORT_SECRET_VALUE_PATTERN);

/**
 * Maps parsed compose services onto catalog definitions (see the contract
 * for the full rules): the image repository picks the definition (its
 * `import.images`), the tag the version, same-name environment variables
 * (plus `import.env` renames) the config and secrets, and the published
 * port the host port, remapped to the next free port of the definition's
 * range when another project pins it, an earlier item claims it or it is
 * busy on 127.0.0.1. Build-only and unmatched services are unsupported and
 * unchecked. Instance names are derived from the compose keys (unique).
 */
export const mapComposeToCatalog: MapComposeToCatalog = async (input) => {
	const claimed = new Set<number>();
	const taken = new Set<string>();
	const items: ImportItem[] = [];
	for (const service of input.parsed.services) {
		const name = uniqueName(slugName(service.name), taken);
		taken.add(name);
		const base = {
			composeName: service.name,
			name,
			...(service.image !== undefined && { image: service.image }),
			config: {},
			secrets: {},
		};
		if (service.build) {
			items.push({
				...base,
				supported: false,
				skipReason: "build",
				include: false,
			});
			continue;
		}
		const image =
			service.image === undefined
				? undefined
				: parseImageRef(interpolateDefaults(service.image) ?? service.image);
		const definition =
			image === undefined
				? undefined
				: input.definitions.find((d) =>
						(d.import?.images ?? []).some(
							(candidate) =>
								parseImageRef(candidate).repository === image.repository,
						),
					);
		if (definition === undefined || image === undefined) {
			items.push({
				...base,
				supported: false,
				skipReason: "no-match",
				include: false,
			});
			continue;
		}
		const version = versionFromTag(image.tag, definition.versions);
		const wantedPort = wantedPortOf(service, definition);
		const port = await pickPort(input, claimed, definition, wantedPort);
		if (port.hostPort !== undefined) claimed.add(port.hostPort);
		items.push({
			...base,
			type: definition.id,
			...(version !== undefined && { version }),
			supported: true,
			include: true,
			...(port.hostPort !== undefined && { hostPort: port.hostPort }),
			wantedPort,
			...(port.remapNote !== undefined && { remapNote: port.remapNote }),
			...configAndSecrets(service, definition),
		});
	}
	return { items };
};

function wantedPortOf(
	service: ComposeImportService,
	definition: ServiceDefinition,
): number {
	const published = service.ports.filter((p) => p.host !== undefined);
	const match = published.find(
		(p) => p.container === definition.port.container,
	);
	return (match ?? published[0])?.host ?? definition.port.default;
}

function configAndSecrets(
	service: ComposeImportService,
	definition: ServiceDefinition,
): Pick<ImportItem, "config" | "secrets"> {
	const config: Record<string, string> = {};
	const secrets: Record<string, string> = {};
	const renames = definition.import?.env ?? {};
	for (const [key, value] of Object.entries(service.environment)) {
		const target = Object.hasOwn(renames, key)
			? renames[key]
			: Object.hasOwn(definition.config, key)
				? `config.${key}`
				: definition.secrets.includes(key)
					? `secrets.${key}`
					: undefined;
		if (target === undefined) continue;
		const dot = target.indexOf(".");
		const root = target.slice(0, dot);
		const name = target.slice(dot + 1);
		if (root === "config") {
			const spec = definition.config[name];
			if (spec === undefined) continue;
			if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value))
				continue;
			config[name] = value;
		} else if (
			definition.secrets.includes(name) &&
			IMPORT_SECRET_VALUE.test(value)
		) {
			secrets[name] = value;
		}
	}
	return { config, secrets };
}

interface PortChoice {
	readonly hostPort?: number;
	readonly remapNote?: string;
}

async function isFree(probe: PortProbe, port: number): Promise<boolean> {
	try {
		return await probe.isFree(port);
	} catch {
		return false;
	}
}

async function pickPort(
	input: MapComposeInput,
	claimed: ReadonlySet<number>,
	definition: ServiceDefinition,
	wanted: number,
): Promise<PortChoice> {
	let remapNote: string | undefined;
	const owner = input.reserved.get(wanted);
	if (claimed.has(wanted)) {
		remapNote = `${wanted} is used by another service in this file`;
	} else if (owner !== undefined) {
		remapNote = `${wanted} is used by ${owner}`;
	} else if (!(await isFree(input.probe, wanted))) {
		remapNote = `${wanted} is in use on this machine`;
	} else {
		return { hostPort: wanted };
	}
	const range = portsInRange(definition.port.range);
	const after = range.filter((port) => port > wanted);
	const before = range.filter((port) => port < wanted);
	let probes = 0;
	for (const port of [...after, ...before]) {
		if (
			port === definition.port.default ||
			claimed.has(port) ||
			input.reserved.has(port)
		) {
			continue;
		}
		if (probes++ >= MAX_SUGGESTION_PROBES) break;
		if (await isFree(input.probe, port)) return { hostPort: port, remapNote };
	}
	return { remapNote };
}
