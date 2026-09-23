import { type Paths, stateFilePath } from "@locainfra/core";
import { ComposeRunner } from "./compose/compose-runner";
import { DockerClient } from "./docker/docker-client";
import { DockerSocketLocator } from "./docker/socket-locator";
import { UnixSocketTransport } from "./docker/unix-socket-transport";
import { BunFileStore } from "./fs/file-store";
import { BindPortProbe } from "./net/port-probe";
import { resolveDefaultPaths } from "./paths/default-paths";
import { FileSecretStore } from "./state/secret-store";
import { FileStateStore } from "./state/state-store";
import { SystemClock } from "./util/clock";
import { CryptoSecretGenerator } from "./util/secret-generator";

/**
 * Every concrete adapter, keyed to match the `*Deps` field names in core's
 * `ops.contract.ts` so composition roots can pass slices straight to ops.
 */
export interface Engines {
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Docker socket discovery. */
	readonly socket: DockerSocketLocator;
	/** Engine API transport (lazily locates the socket, negotiates the API version). */
	readonly transport: UnixSocketTransport;
	/** Engine API reads (`DockerInfoPort` + `ContainerReader`). */
	readonly docker: DockerClient;
	/** `docker compose` version (`ComposeInfoPort`). Same instance as {@link Engines.lifecycle}. */
	readonly compose: ComposeRunner;
	/** `docker compose` lifecycle (`LifecycleRunner`). */
	readonly lifecycle: ComposeRunner;
	/** `state.json` (`StateReader` + `StateWriter`). */
	readonly state: FileStateStore;
	/** Per-stack secrets (0600). */
	readonly secrets: FileSecretStore;
	/** Text file access. */
	readonly files: BunFileStore;
	/** 127.0.0.1 bind probe. */
	readonly probe: BindPortProbe;
	/** Secret generator. */
	readonly gen: CryptoSecretGenerator;
	/** System clock. */
	readonly clock: SystemClock;
}

/**
 * Builds all adapters. Cheap and side-effect free: nothing touches Docker or the
 * filesystem until a method is called.
 *
 * @param paths - Filesystem layout (default {@link resolveDefaultPaths}, honouring `LOCAINFRA_HOME`).
 * @returns The adapter set.
 */
export function createEngines(paths: Paths = resolveDefaultPaths()): Engines {
	const clock = new SystemClock();
	const socket = new DockerSocketLocator();
	const transport = new UnixSocketTransport({ locator: socket });
	const composeRunner = new ComposeRunner({ clock });
	return {
		paths,
		socket,
		transport,
		docker: new DockerClient(transport),
		compose: composeRunner,
		lifecycle: composeRunner,
		state: new FileStateStore({ filePath: stateFilePath(paths) }),
		secrets: new FileSecretStore(paths),
		files: new BunFileStore(),
		probe: new BindPortProbe(),
		gen: new CryptoSecretGenerator(),
		clock,
	};
}
