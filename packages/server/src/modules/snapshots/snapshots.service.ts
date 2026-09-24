import { OpError, type Snapshot, snapshotMismatch } from "@locastack/core";
import type { ServerOps, ServerPorts } from "../../deps";
import type { OpAccepted } from "../../models/common.model";
import { ServiceLookup } from "../../shared/service-lookup";
import { unwrap } from "../../shared/unwrap";
import type { OpLauncher, ProjectLane } from "../observer/op-registry";
import type { CreateSnapshotBody } from "./snapshots.model";

/** Ops used by {@link SnapshotsService}. */
export type SnapshotsOps = Pick<
	ServerOps,
	| "loadProject"
	| "getService"
	| "listSnapshots"
	| "createSnapshot"
	| "restoreSnapshot"
	| "deleteSnapshot"
	| "seedService"
>;

/**
 * Snapshots and seeding of one service instance. Create, restore and seed
 * touch containers, so they answer `202 { opId }` (progress via
 * `GET /api/ops/:opId/events`) after cheap pre-checks that turn the common
 * mistakes into a direct `404`/`409`/`422`; list and delete are plain
 * results.
 */
export class SnapshotsService {
	private readonly lookup: ServiceLookup;

	/**
	 * @param ops - Core ops.
	 * @param ports - Ports passed to the ops.
	 * @param launcher - Starts long-running ops; its project lane also
	 *   serializes deletes with them.
	 */
	constructor(
		private readonly ops: SnapshotsOps,
		private readonly ports: ServerPorts,
		private readonly launcher: OpLauncher & ProjectLane,
	) {
		this.lookup = new ServiceLookup(ops, ports);
	}

	/**
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @returns Its snapshots, newest first.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async list(project: string, name: string): Promise<Snapshot[]> {
		return unwrap(await this.ops.listSnapshots(this.ports, { project, name }));
	}

	/**
	 * Stops the service (when running), archives its volume(s), starts it again.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param body - Optional display name.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`; `INVALID_INPUT`
	 * when the service is ephemeral or its definition has no volume.
	 */
	async create(
		project: string,
		name: string,
		body: CreateSnapshotBody,
	): Promise<OpAccepted> {
		const { entry, definition } = await this.lookup.service(project, name);
		if ((entry.persist ?? "volume") === "ephemeral")
			throw new OpError(
				"INVALID_INPUT",
				`${name} is ephemeral: it has no data volume to snapshot.`,
				{
					details: {
						field: "persist",
						fix: "Set Persist to volume on the Config page",
					},
				},
			);
		if (definition !== undefined && definition.volumes.length === 0)
			throw new OpError(
				"INVALID_INPUT",
				`${definition.name} keeps no data in a volume, so there is nothing to snapshot.`,
			);
		const snapshotName = body.name;
		return this.launch("snapshot.create", project, name, () =>
			this.ops.createSnapshot(this.ports, {
				project,
				name,
				...(snapshotName === undefined ? {} : { snapshotName }),
			}),
		);
	}

	/**
	 * Stops the service, replaces its volume contents with the snapshot, starts it.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param snapshotId - Snapshot id.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`,
	 * `SNAPSHOT_NOT_FOUND` (unknown id, or another service's snapshot);
	 * `INVALID_INPUT` when it was taken from another catalog type or major
	 * version (`details.reason`, `details.fix`).
	 */
	async restore(
		project: string,
		name: string,
		snapshotId: string,
	): Promise<OpAccepted> {
		const { entry, definition } = await this.lookup.service(project, name);
		const record = await this.ports.snapshots.get(snapshotId);
		if (
			record === null ||
			record.project !== project ||
			record.service !== name
		)
			throw new OpError(
				"SNAPSHOT_NOT_FOUND",
				`No snapshot ${snapshotId} for ${name}`,
			);
		// Another type's data, or another major version's, never replaces the volume.
		const mismatch =
			definition === undefined
				? undefined
				: snapshotMismatch(record, entry, definition);
		if (mismatch !== undefined) throw mismatch;
		return this.launch("snapshot.restore", project, name, () =>
			this.ops.restoreSnapshot(this.ports, { project, name, snapshotId }),
		);
	}

	/**
	 * Deletes a snapshot's file and index row (no container is touched). It
	 * runs in the project's op lane, so it waits for a create / restore /
	 * seed in flight (a restore reading this archive never loses it midway)
	 * and ops started meanwhile wait for it.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param snapshotId - Snapshot id.
	 * @returns The deleted snapshot.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`.
	 */
	async remove(
		project: string,
		name: string,
		snapshotId: string,
	): Promise<Snapshot> {
		return unwrap(
			await this.launcher.exclusive(project, () =>
				this.ops.deleteSnapshot(this.ports, { project, name, snapshotId }),
			),
		);
	}

	/**
	 * Re-applies the service's seed file in its running container.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`; `INVALID_INPUT`
	 * when the type has no seed support or no seed file is set;
	 * `SERVICE_NOT_RUNNING` when it is not running.
	 */
	async seed(project: string, name: string): Promise<OpAccepted> {
		const { entry, definition } = await this.lookup.service(project, name);
		if (definition !== undefined && definition.seed === undefined)
			throw new OpError(
				"INVALID_INPUT",
				`${definition.name} does not support seed files.`,
			);
		if (entry.seed === undefined)
			throw new OpError("INVALID_INPUT", `${name} has no seed file.`, {
				details: { field: "seed", fix: "Set a seed file on the Config page" },
			});
		const detail = unwrap(
			await this.ops.getService(this.ports, { project, name }),
		);
		if (detail.state !== "running")
			throw new OpError(
				"SERVICE_NOT_RUNNING",
				`${name} is not running. Start it to apply the seed file.`,
			);
		return this.launch("service.seed", project, name, () =>
			this.ops.seedService(this.ports, { project, name }),
		);
	}

	private launch(
		kind: string,
		project: string,
		service: string,
		run: () => ReturnType<ServerOps["seedService"]>,
	): OpAccepted {
		return { opId: this.launcher.start({ kind, project, service, run }) };
	}
}
