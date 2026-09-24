import type { ServiceDefinition, ServiceDetail } from "@locastack/server";

/**
 * Whether a service has a data volume the server can snapshot (it archives
 * exactly one catalog volume of a `persist: volume` service):
 *
 * - `ok`: yes;
 * - `ephemeral`: the service keeps no data (`persist: ephemeral`);
 * - `none`: its type keeps no data volume (e.g. Upstash);
 * - `several`: its type has more than one volume.
 */
export type SnapshotVolume = "ok" | "ephemeral" | "none" | "several";

/**
 * @param service - The service instance.
 * @param definition - Its catalog definition (`undefined` while the catalog loads).
 * @returns Its {@link SnapshotVolume}; `ok` while the definition is unknown.
 */
export function snapshotVolumeOf(
	service: Pick<ServiceDetail, "persist">,
	definition: Pick<ServiceDefinition, "volumes"> | undefined,
): SnapshotVolume {
	if (service.persist !== "volume") return "ephemeral";
	if (definition === undefined) return "ok";
	if (definition.volumes.length === 0) return "none";
	return definition.volumes.length === 1 ? "ok" : "several";
}

/**
 * @param name - Service instance name.
 * @param volume - Why it cannot be snapshotted.
 * @returns The Snapshots tab's empty-state copy.
 */
export function noSnapshotCopy(
	name: string,
	volume: Exclude<SnapshotVolume, "ok">,
): string {
	switch (volume) {
		case "ephemeral":
			return `${name} is ephemeral: it keeps no volume to snapshot.`;
		case "none":
			return `${name} keeps no data volume to snapshot.`;
		case "several":
			return `${name} has several data volumes; snapshots support one.`;
	}
}
