import {
	type ConnectionInfo,
	checkSeedFile,
	OpError,
	type RotateSecretOptions,
	type ServiceDefinition,
	type ServiceDetail,
	type ServicePatch,
	type ServiceStatus,
	type Stack,
	suggestFreePort,
	WIPE_NEEDS_FORCE_FIX,
} from "@locastack/core";
import type { ServerOps, ServerPorts } from "../../deps";
import type { OpAccepted } from "../../models/common.model";
import { unwrap } from "../../shared/unwrap";
import type { OpLauncher } from "../observer/op-registry";
import {
	type AddServiceBody,
	type DataCapability,
	DEFAULT_LOG_TAIL,
	type LogTail,
	type ServiceView,
	type StatsReading,
} from "./services.model";

/**
 * `details.fix` of a refused rotation of a secret the catalog marks
 * `bakedIntoVolume` while the service keeps a data volume.
 */
export const BAKED_SECRET_FIX =
	"The password is stored in the data volume on first start; rotating it needs the volume wiped. Take a snapshot first, then rotate with Wipe volume.";

/**
 * @param definition - Catalog definition, if the type is known.
 * @returns The Data tab capability (`none` without a usable `data` block).
 */
export function dataCapability(
	definition: ServiceDefinition | undefined,
): DataCapability {
	const data = definition?.data;
	if (data === undefined || data.kind === "none") return { kind: "none" };
	return data.label === undefined
		? { kind: data.kind }
		: { kind: data.kind, label: data.label };
}

/**
 * Longest wait for a one-shot stats reading. Docker sends a frame about once
 * per second and the first one has no CPU delta, so the second is wanted.
 */
export const STATS_READING_TIMEOUT_MS = 2500;

/** Upper bound on a one-shot log read, so a stuck Docker socket cannot hang the request. */
export const LOG_TAIL_TIMEOUT_MS = 5000;

/** Ops used by {@link ServicesService}. */
export type ServicesOps = Pick<
	ServerOps,
	| "loadProject"
	| "statusForProject"
	| "getService"
	| "addService"
	| "removeService"
	| "updateService"
	| "startService"
	| "stopService"
	| "restartService"
	| "getConnection"
	| "rotateSecret"
>;

/** Copies live CPU/MEM onto a row. */
export interface RowUsage {
	/** @returns The row with usage where known. */
	rowWithUsage<T extends ServiceStatus>(row: T): T;
}

/**
 * Service instances of one project: detail, connection, and the
 * long-running actions (add, patch, remove, start, stop, restart). Cheap
 * checks (project/service exist, catalog type/version/config keys, explicit
 * port free) run before the `202` so the UI gets a `404`/`409`/`422` directly.
 */
export class ServicesService {
	/**
	 * @param ops - Core ops.
	 * @param ports - Ports passed to the ops.
	 * @param launcher - Starts long-running ops.
	 * @param usage - Observer CPU/MEM overlay.
	 */
	constructor(
		private readonly ops: ServicesOps,
		private readonly ports: ServerPorts,
		private readonly launcher: OpLauncher,
		private readonly usage: RowUsage,
	) {}

	/**
	 * @param project - Project name.
	 * @returns Every service's detail with its Data tab capability, in file order.
	 * @throws OpError `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`, `INVALID_STACK`.
	 */
	async list(project: string): Promise<ServiceView[]> {
		const stack = await this.load(project);
		const names = Object.keys(stack.file.services);
		const [details, definitions] = await Promise.all([
			Promise.all(
				names.map(async (name) =>
					unwrap(await this.ops.getService(this.ports, { project, name })),
				),
			),
			this.ports.catalog.definitions(),
		]);
		return details.map((d) => this.view(d, definitions));
	}

	/**
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @returns Its detail with the Data tab capability.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async detail(project: string, name: string): Promise<ServiceView> {
		const [detail, definitions] = await Promise.all([
			this.ops.getService(this.ports, { project, name }),
			this.ports.catalog.definitions(),
		]);
		return this.view(unwrap(detail), definitions);
	}

	/**
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param reveal - Include secret values.
	 * @returns Connect tab data.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async connection(
		project: string,
		name: string,
		reveal: boolean,
	): Promise<ConnectionInfo> {
		return unwrap(
			await this.ops.getConnection(this.ports, { project, name, reveal }),
		);
	}

	/**
	 * The last `tail` log lines of a service, read once (`follow=false`): the
	 * Logs tab's initial view without opening a WebSocket. A service without
	 * a container (never started, or removed meanwhile) has no lines.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param tail - Trailing lines wanted (default 200).
	 * @returns The lines, oldest first.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async logTail(
		project: string,
		name: string,
		tail: number = DEFAULT_LOG_TAIL,
	): Promise<LogTail> {
		const service = unwrap(
			await this.ops.getService(this.ports, { project, name }),
		);
		if (service.containerId === undefined || tail === 0) return { lines: [] };
		const lines: LogTail["lines"] = [];
		try {
			for await (const line of this.ports.streams.logs(service.containerId, {
				follow: false,
				tail,
				signal: AbortSignal.timeout(LOG_TAIL_TIMEOUT_MS),
			})) {
				lines.push(line);
			}
		} catch (error) {
			// The container vanished between the lookup and the read.
			if (error instanceof OpError && error.code === "SERVICE_NOT_FOUND")
				return { lines: [] };
			throw error;
		}
		return { lines: lines.slice(-tail) };
	}

	/**
	 * One resource reading of a running service (Metrics tab without Live):
	 * opens the stats stream, keeps the second frame (the first has no CPU
	 * delta) or whatever arrived within {@link STATS_READING_TIMEOUT_MS}, and
	 * closes the stream.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @returns At most one sample; none when there is no running container.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async statsReading(project: string, name: string): Promise<StatsReading> {
		const service = unwrap(
			await this.ops.getService(this.ports, { project, name }),
		);
		if (service.containerId === undefined || service.state !== "running")
			return { samples: [] };
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), STATS_READING_TIMEOUT_MS);
		let latest: StatsReading["samples"][number] | undefined;
		let seen = 0;
		try {
			for await (const sample of this.ports.streams.stats(
				service.containerId,
				abort.signal,
			)) {
				latest = sample;
				seen += 1;
				if (seen >= 2) break;
			}
		} catch (error) {
			if (!(error instanceof OpError && error.code === "SERVICE_NOT_FOUND"))
				throw error;
		} finally {
			clearTimeout(timer);
			abort.abort();
		}
		return { samples: latest === undefined ? [] : [latest] };
	}

	/**
	 * Add & start.
	 *
	 * @param project - Project name.
	 * @param body - New instance.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_EXISTS`, `INVALID_INPUT`, `PORT_CONFLICT`.
	 */
	async add(project: string, body: AddServiceBody): Promise<OpAccepted> {
		const stack = await this.load(project);
		if (stack.file.services[body.name] !== undefined)
			throw new OpError(
				"SERVICE_EXISTS",
				`A service named ${body.name} already exists in ${project}`,
				{ details: { fix: "Choose another name" } },
			);
		const definition = await this.checkAgainstCatalog(body);
		if (body.seed !== undefined)
			await this.checkSeed(stack, definition, body.seed);
		if (typeof body.port === "number")
			await this.checkPortFree(body.port, definition);
		const { name, ...entry } = body;
		return this.launch("service.add", project, name, () =>
			this.ops.addService(this.ports, { project, name, ...entry }),
		);
	}

	/**
	 * Changes version, port, persist, config or seed, then recreates the service.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param patch - Fields to change (`seed: ""` removes the seed file).
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`; `INVALID_INPUT`
	 * for a seed on a type without seed support or a missing seed file.
	 */
	async update(
		project: string,
		name: string,
		patch: ServicePatch,
	): Promise<OpAccepted> {
		const stack = await this.load(project);
		const entry = this.requireEntry(stack, project, name);
		if (patch.seed !== undefined && patch.seed !== "") {
			const definition = (await this.ports.catalog.definitions()).find(
				(d) => d.id === entry.type,
			);
			if (definition !== undefined)
				await this.checkSeed(stack, definition, patch.seed);
		}
		return this.launch("service.update", project, name, () =>
			this.ops.updateService(this.ports, { project, name, patch }),
		);
	}

	/**
	 * Removes the container and the entry (optionally its volumes).
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param volumes - Also delete its named volumes.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async remove(
		project: string,
		name: string,
		volumes: boolean,
	): Promise<OpAccepted> {
		await this.requireService(project, name);
		return this.launch("service.remove", project, name, () =>
			this.ops.removeService(this.ports, { project, name, volumes }),
		);
	}

	/**
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param action - Lifecycle action.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`.
	 */
	async lifecycle(
		project: string,
		name: string,
		action: "start" | "stop" | "restart",
	): Promise<OpAccepted> {
		await this.requireService(project, name);
		const ref = { project, name };
		const run = {
			start: () => this.ops.startService(this.ports, ref),
			stop: () => this.ops.stopService(this.ports, ref),
			restart: () => this.ops.restartService(this.ports, ref),
		}[action];
		return this.launch(`service.${action}`, project, name, run);
	}

	/**
	 * Generates a new value for one secret and recreates the container. A
	 * secret the catalog marks `bakedIntoVolume` on a service with a data
	 * volume is refused unless both `force` and `wipeVolume` are set, and
	 * `wipeVolume` without `force` is refused for every secret.
	 *
	 * @param project - Project name.
	 * @param name - Service instance.
	 * @param key - Catalog secret name, e.g. `POSTGRES_PASSWORD`.
	 * @param options - `force` / `wipeVolume`.
	 * @returns The operation id.
	 * @throws OpError `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`; `INVALID_INPUT`
	 * for an unknown key or a refused baked-in secret (`details.fix`).
	 */
	async rotateSecret(
		project: string,
		name: string,
		key: string,
		options: RotateSecretOptions,
	): Promise<OpAccepted> {
		const stack = await this.load(project);
		const entry = this.requireEntry(stack, project, name);
		const definition = (await this.ports.catalog.definitions()).find(
			(d) => d.id === entry.type,
		);
		if (definition !== undefined) {
			if (!definition.secrets.includes(key))
				throw new OpError(
					"INVALID_INPUT",
					`${definition.name} has no secret ${key}`,
					{ details: { field: "key", secrets: [...definition.secrets] } },
				);
			const baked = definition.secretOptions?.[key]?.bakedIntoVolume === true;
			const hasVolume =
				(entry.persist ?? "volume") === "volume" &&
				definition.volumes.length > 0;
			if (
				baked &&
				hasVolume &&
				!(options.force === true && options.wipeVolume === true)
			)
				throw new OpError(
					"INVALID_INPUT",
					`${key} of ${name} is stored in its data volume and cannot be rotated in place.`,
					{
						details: {
							field: "key",
							bakedIntoVolume: true,
							fix: BAKED_SECRET_FIX,
						},
					},
				);
		}
		// Deleting a volume is destructive for every secret, baked or not.
		if (options.wipeVolume === true && options.force !== true)
			throw new OpError(
				"INVALID_INPUT",
				`Wiping the data volume of ${name} needs force.`,
				{ details: { field: "force", fix: WIPE_NEEDS_FORCE_FIX } },
			);
		return this.launch("service.rotate-secret", project, name, () =>
			this.ops.rotateSecret(this.ports, {
				project,
				name,
				key,
				...(options.force === undefined ? {} : { force: options.force }),
				...(options.wipeVolume === undefined
					? {}
					: { wipeVolume: options.wipeVolume }),
			}),
		);
	}

	private view(
		detail: ServiceDetail,
		definitions: readonly ServiceDefinition[],
	): ServiceView {
		const definition = definitions.find((d) => d.id === detail.type);
		return {
			...this.usage.rowWithUsage(detail),
			data: dataCapability(definition),
		};
	}

	private requireEntry(stack: Stack, project: string, name: string) {
		const entry = stack.file.services[name];
		if (entry === undefined)
			throw new OpError(
				"SERVICE_NOT_FOUND",
				`No service named ${name} in ${project}`,
			);
		return entry;
	}

	/**
	 * A seed needs a definition with a `seed` block and an existing file
	 * under the project root (otherwise Docker would create a directory at
	 * the bind-mount source).
	 */
	private async checkSeed(
		stack: Stack,
		definition: ServiceDefinition,
		seed: string,
	): Promise<void> {
		if (definition.seed === undefined)
			throw new OpError(
				"INVALID_INPUT",
				`${definition.name} does not support seed files`,
				{ details: { field: "seed" } },
			);
		// Canonical path inside the project and a regular file: a symlink to
		// ~/.aws/credentials or /dev/zero, a folder or a FIFO is refused.
		const checked = await checkSeedFile(this.ports.files, stack.root, seed);
		if (!checked.ok) {
			const { error } = checked;
			throw new OpError(
				"INVALID_INPUT",
				error.details?.reason === "missing"
					? `Seed file ./${seed} was not found in the project folder`
					: error.message,
				{
					details: {
						field: "seed",
						fix:
							error.details?.reason === "missing"
								? `Create ./${seed} next to locastack.yaml`
								: error.details?.fix,
					},
				},
			);
		}
	}

	private launch(
		kind: string,
		project: string,
		service: string,
		run: () => ReturnType<ServerOps["startService"]>,
	): OpAccepted {
		return { opId: this.launcher.start({ kind, project, service, run }) };
	}

	private async load(project: string): Promise<Stack> {
		return unwrap(await this.ops.loadProject(this.ports, { project }));
	}

	private async requireService(project: string, name: string): Promise<void> {
		this.requireEntry(await this.load(project), project, name);
	}

	private async checkAgainstCatalog(
		body: AddServiceBody,
	): Promise<ServiceDefinition> {
		const definitions = await this.ports.catalog.definitions();
		const definition = definitions.find((d) => d.id === body.type);
		if (definition === undefined)
			throw new OpError("INVALID_INPUT", `Unknown service type ${body.type}`, {
				details: { field: "type" },
			});
		if (
			body.version !== undefined &&
			!definition.versions.includes(body.version)
		)
			throw new OpError(
				"INVALID_INPUT",
				`${definition.name} has no version ${body.version}`,
				{ details: { field: "version", versions: [...definition.versions] } },
			);
		const secretNames = new Set(definition.secrets);
		const unknownSecrets = Object.keys(body.secrets ?? {}).filter(
			(k) => !secretNames.has(k),
		);
		if (unknownSecrets.length > 0)
			throw new OpError(
				"INVALID_INPUT",
				`Unknown ${definition.name} secret ${unknownSecrets.join(", ")}`,
				{ details: { field: "secrets", keys: unknownSecrets } },
			);
		const known = new Set(Object.keys(definition.config ?? {}));
		const unknown = Object.keys(body.config ?? {}).filter((k) => !known.has(k));
		if (unknown.length > 0)
			throw new OpError(
				"INVALID_INPUT",
				`Unknown ${definition.name} setting ${unknown.join(", ")}`,
				{ details: { field: "config", keys: unknown } },
			);
		return definition;
	}

	/**
	 * An explicit port must be free on 127.0.0.1 and not pinned by another
	 * project's service (a stopped container still owns its pinned port).
	 * Same `PORT_CONFLICT` shape as core: `details.port` is the busy port and
	 * `details.suggestedPort` the fix.
	 */
	private async checkPortFree(
		port: number,
		definition: ServiceDefinition,
	): Promise<void> {
		const state = await this.ports.state.read();
		const pinnedBy = Object.entries(state.stacks).find(([, stack]) =>
			Object.values(stack.ports).includes(port),
		)?.[0];
		if (pinnedBy === undefined && (await this.ports.probe.isFree(port))) return;
		const suggestedPort = await suggestFreePort(
			this.ports.probe,
			state,
			definition,
			[port],
		);
		const reason =
			pinnedBy === undefined
				? `Port ${port} is already in use on this machine`
				: `Port ${port} is reserved by project ${pinnedBy}`;
		throw new OpError("PORT_CONFLICT", reason, {
			details:
				suggestedPort === undefined
					? { port, fix: "Choose another port or use auto" }
					: { port, suggestedPort, fix: `Use port ${suggestedPort}` },
		});
	}
}
