import type { ServiceDefinition } from "@locastack/server";
import { parse } from "yaml";
import type {
	ImportItem,
	ImportPreview,
} from "@/features/import/api/import.api";

const NAME = /^[a-z][a-z0-9-]*$/;
const SECRET_VALUE = /^[A-Za-z0-9._~-]{1,256}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** What the mock needs to know about ports already taken. */
export interface MockPortOwners {
	/** Port → "project/service" of another project's pin. */
	readonly pinned: ReadonlyMap<number, string>;
	/** Ports bound by some other process on this machine. */
	readonly busy: readonly number[];
}

/** A preview failure (`422 INVALID_INPUT`). */
export interface MockImportError {
	readonly error: string;
}

const repository = (image: string) =>
	image
		.replace(/@.*$/, "")
		.replace(/:[^/]*$/, "")
		.replace(/^docker\.io\/(library\/)?/, "");

const tagOf = (image: string) => /:([^/@]+)(@.*)?$/.exec(image)?.[1];

const environment = (value: unknown): Record<string, string> => {
	if (Array.isArray(value))
		return Object.fromEntries(
			value
				.filter((v): v is string => typeof v === "string" && v.includes("="))
				.map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]),
		);
	if (isRecord(value))
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, String(v ?? "")]),
		);
	return {};
};

const firstHostPort = (value: unknown): number | undefined => {
	if (!Array.isArray(value)) return undefined;
	const first: unknown = value[0];
	if (typeof first === "number") return first;
	if (typeof first === "string") {
		const parts = first.split(":");
		return parts.length > 1 ? Number(parts.at(-2)) : undefined;
	}
	if (isRecord(first) && typeof first.published !== "undefined")
		return Number(first.published);
	return undefined;
};

const instanceName = (composeName: string, taken: Set<string>) => {
	let base = composeName.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	if (!/^[a-z]/.test(base)) base = `svc-${base}`;
	base = base.replace(/-+$/, "") || "svc";
	let name = base;
	for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}`;
	taken.add(name);
	return name;
};

/**
 * Mirrors `previewImport`: parses compose YAML, matches images against each
 * definition's `import.images`, maps env vars named like config keys and
 * secrets, and remaps ports taken by other projects, this machine or earlier
 * items of the file.
 *
 * @param yaml - Compose text.
 * @param projectName - Preferred name.
 * @param catalog - Definitions.
 * @param takenProjects - Registered project names.
 * @param owners - Taken ports.
 * @returns The preview, or an error line.
 */
export function mockPreviewImport(
	yaml: string,
	projectName: string | undefined,
	catalog: readonly ServiceDefinition[],
	takenProjects: readonly string[],
	owners: MockPortOwners,
): ImportPreview | MockImportError {
	let doc: unknown;
	try {
		doc = parse(yaml);
	} catch (error) {
		return {
			error: `Invalid YAML: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : ""}`,
		};
	}
	if (!isRecord(doc) || !isRecord(doc.services))
		return { error: "No services found in this file." };
	const names = new Set<string>();
	const claimed = new Set<number>();
	const items: ImportItem[] = Object.entries(doc.services).map(
		([composeName, raw]) => {
			const svc = isRecord(raw) ? raw : {};
			const image = typeof svc.image === "string" ? svc.image : undefined;
			const build = svc.build !== undefined;
			const def = image
				? catalog.find((d) => d.import?.images.includes(repository(image)))
				: undefined;
			const name = instanceName(composeName, names);
			if (!def || build || !image) {
				return {
					composeName,
					name,
					...(image ? { image } : {}),
					supported: false,
					skipReason: build && !image ? "build" : "no-match",
					include: false,
					config: {},
					secrets: {},
				} satisfies ImportItem;
			}
			const tag = tagOf(image);
			const major = tag?.split("-")[0]?.split(".")[0];
			const version =
				tag && def.versions.includes(tag)
					? tag
					: major && def.versions.includes(major)
						? major
						: undefined;
			const env = environment(svc.environment);
			const config = Object.fromEntries(
				Object.keys(def.config)
					.filter((k) => env[k] !== undefined)
					.map((k) => [k, env[k] ?? ""]),
			);
			const secrets = Object.fromEntries(
				def.secrets
					.filter(
						(k) => env[k] !== undefined && SECRET_VALUE.test(env[k] ?? ""),
					)
					.map((k) => [k, env[k] ?? ""]),
			);
			const wantedPort = firstHostPort(svc.ports) ?? def.port.default;
			const reason = (port: number) =>
				owners.pinned.has(port)
					? `${port} is used by ${owners.pinned.get(port)}`
					: owners.busy.includes(port)
						? `${port} is in use on this machine`
						: claimed.has(port)
							? `${port} is used by another service in this file`
							: undefined;
			const remapNote = reason(wantedPort);
			let hostPort = wantedPort;
			while (reason(hostPort)) hostPort += 1;
			claimed.add(hostPort);
			return {
				composeName,
				name,
				image,
				type: def.id,
				...(version ? { version } : {}),
				supported: true,
				include: true,
				hostPort,
				wantedPort,
				...(remapNote ? { remapNote } : {}),
				config,
				secrets,
			} satisfies ImportItem;
		},
	);
	if (items.length === 0) return { error: "No services found in this file." };
	let suggestedName =
		projectName &&
		NAME.test(projectName) &&
		!takenProjects.includes(projectName)
			? projectName
			: "compose-app";
	for (let i = 2; takenProjects.includes(suggestedName); i += 1)
		suggestedName = `compose-app-${i}`;
	return { suggestedName, items };
}
