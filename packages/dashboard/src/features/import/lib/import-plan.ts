import type { ServiceDefinition } from "@locastack/server";
import type { ImportItem } from "../api/import.api";

/** Largest compose text the server accepts (`IMPORT_YAML_MAX_BYTES`). */
export const IMPORT_MAX_BYTES = 512 * 1024;

/** File name shown for pasted text. */
export const PASTED_FILE_NAME = "pasted YAML";

/** The prototype's "Use sample file" compose file. */
export const SAMPLE_COMPOSE = `services:
  web:
    build: .
    ports:
      - "3000:3000"
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: shop
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"
  cache:
    image: redis:7.4
    ports:
      - "6379:6379"
  storage:
    image: minio/minio:latest
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    ports:
      - "9000:9000"
  mailhog:
    image: mailhog/mailhog
    ports:
      - "8025:8025"`;

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Project name suggested by a compose file name, like the prototype:
 * `shop.docker-compose.yml` → `shop`; generic names give nothing.
 *
 * @param fileName - Dropped or chosen file name.
 * @returns A candidate name (the server re-checks it), or `undefined`.
 */
export function nameFromFileName(fileName: string): string | undefined {
	const base = fileName
		.replace(/\.(ya?ml)$/i, "")
		.replace(/docker-compose\.?|compose\.?/i, "")
		.replace(/[.-]+$/, "")
		.replace(/^[.-]+/, "");
	return base && NAME_PATTERN.test(base) ? base : undefined;
}

/**
 * Validates the imported project's name (prototype copy).
 *
 * @param name - Typed name.
 * @param taken - Registered project names.
 * @returns An error message, or `undefined` when valid.
 */
export function validateImportName(
	name: string,
	taken: readonly string[],
): string | undefined {
	if (!name) return "Project name is required.";
	if (!NAME_PATTERN.test(name))
		return "Use lowercase letters, numbers and dashes.";
	if (taken.includes(name)) return "That name is taken.";
	return undefined;
}

/**
 * Items that will be imported.
 *
 * @param items - Preview items with the user's include toggles.
 * @returns The supported, included ones.
 */
export const includedItems = (items: readonly ImportItem[]): ImportItem[] =>
	items.filter((i) => i.supported && i.include);

/**
 * "Import 3 services" / "Import 1 service".
 *
 * @param count - Included items.
 * @returns The button label.
 */
export const importLabel = (count: number): string =>
	`Import ${count} service${count === 1 ? "" : "s"}`;

/**
 * "Becomes" column: `PostgreSQL 16`, or why the service is skipped.
 *
 * @param item - Preview item.
 * @param definitions - Catalog definitions.
 * @returns The label.
 */
export function itemTarget(
	item: ImportItem,
	definitions: readonly ServiceDefinition[],
): string {
	const def = definitions.find((d) => d.id === item.type);
	if (item.supported && def)
		return `${def.name} ${item.version ?? def.defaultVersion}`;
	return item.skipReason === "build"
		? "Your app, runs outside LocaStack"
		: "No matching service in catalog";
}

/**
 * Note under "Becomes": Skipped / Remapped, <why> / Excluded.
 *
 * @param item - Preview item.
 * @returns The note, or `undefined`.
 */
export function itemNote(item: ImportItem): string | undefined {
	if (!item.supported) return "Skipped";
	if (!item.include) return "Excluded";
	if (item.remapNote) return `Remapped, ${item.remapNote}`;
	return undefined;
}

/**
 * "Host port" column: `5433`, `5432 → 5433` when remapped, `—` when not imported.
 *
 * @param item - Preview item.
 * @returns The label.
 */
export function itemPortText(item: ImportItem): string {
	if (!item.supported || !item.include || item.hostPort === undefined)
		return item.wantedPort === undefined ? "—" : String(item.wantedPort);
	return item.wantedPort !== undefined && item.wantedPort !== item.hostPort
		? `${item.wantedPort} → ${item.hostPort}`
		: String(item.hostPort);
}
