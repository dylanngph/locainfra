import type { Paths } from "@locainfra/core";
import { ComposeRunner } from "./compose/compose-runner";
import { SystemBrowserOpener } from "./desktop/browser-opener";
import { NativeFolderPicker } from "./desktop/folder-picker";
import { DockerContainerExec } from "./docker/container-exec";
import { DockerContainerStreams } from "./docker/container-streams";
import { DockerClient } from "./docker/docker-client";
import { UnixSocketHijacker } from "./docker/hijack";
import { DockerSocketLocator } from "./docker/socket-locator";
import { UnixSocketTransport } from "./docker/unix-socket-transport";
import { DockerVolumeArchiver } from "./docker/volume-archiver";
import { BunFileStore } from "./fs/file-store";
import { BindPortProbe } from "./net/port-probe";
import { resolveDefaultPaths } from "./paths/default-paths";
import { FileSecretStore } from "./state/secret-store";
import { SqliteOpJournal } from "./state/sqlite/op-journal";
import { SqliteSnapshotIndex } from "./state/sqlite/snapshot-index";
import { SqliteStateStore } from "./state/sqlite/sqlite-state-store";
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
	/** Engine API reads (`DockerInfoPort` + `ContainerReader` + `ContainerInspector`). */
	readonly docker: DockerClient;
	/** Container listing (`ContainerReader`). Same instance as {@link Engines.docker}. */
	readonly containers: DockerClient;
	/** Container inspect (`ContainerInspector`). Same instance as {@link Engines.docker}. */
	readonly inspector: DockerClient;
	/** Long-lived logs / stats / events streams (`ContainerStreams`). */
	readonly streams: DockerContainerStreams;
	/** `docker compose` version (`ComposeInfoPort`). Same instance as {@link Engines.lifecycle}. */
	readonly compose: ComposeRunner;
	/** `docker compose` lifecycle (`LifecycleRunner`). */
	readonly lifecycle: ComposeRunner;
	/** `locainfra.db`, SQLite (`StateReader` + `StateWriter`; opened lazily). */
	readonly state: SqliteStateStore;
	/** `docker exec` over the Engine API (`ContainerExec`; stdin via a hijacked connection). */
	readonly exec: DockerContainerExec;
	/** Volume tar/untar with a `docker run --rm` helper (`VolumeArchiver`). */
	readonly archiver: DockerVolumeArchiver;
	/** Snapshot index on `locainfra.db` (`SnapshotIndex`; shares {@link Engines.state}'s connection). */
	readonly snapshots: SqliteSnapshotIndex;
	/** Operation history on `locainfra.db` (`OpJournal`; shares {@link Engines.state}'s connection). */
	readonly journal: SqliteOpJournal;
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
	/** Native folder dialog on this machine (`FolderPicker`). */
	readonly folderPicker: NativeFolderPicker;
	/** Default-browser launcher (`BrowserOpener`). */
	readonly browser: SystemBrowserOpener;
}

/**
 * Builds all adapters. Cheap and side-effect free: nothing touches Docker, the
 * filesystem or the desktop until a method is called. The built-in catalog is
 * not an engine: composition roots resolve its folder with
 * `resolveBuiltinCatalogDir` (from this package) and build the catalog source in core.
 *
 * @param paths - Filesystem layout (default {@link resolveDefaultPaths}, honouring `LOCAINFRA_HOME`).
 * @returns The adapter set.
 */
export function createEngines(paths: Paths = resolveDefaultPaths()): Engines {
	const clock = new SystemClock();
	const socket = new DockerSocketLocator();
	const transport = new UnixSocketTransport({ locator: socket });
	const composeRunner = new ComposeRunner({ clock });
	const docker = new DockerClient(transport);
	const state = new SqliteStateStore({ stateDir: paths.stateDir, clock });
	return {
		paths,
		socket,
		transport,
		docker,
		containers: docker,
		inspector: docker,
		streams: new DockerContainerStreams(transport, { clock }),
		compose: composeRunner,
		lifecycle: composeRunner,
		state,
		exec: new DockerContainerExec(transport, {
			hijacker: new UnixSocketHijacker(transport),
		}),
		archiver: new DockerVolumeArchiver({ clock }),
		snapshots: new SqliteSnapshotIndex(state),
		journal: new SqliteOpJournal(state),
		secrets: new FileSecretStore(paths),
		files: new BunFileStore(),
		probe: new BindPortProbe(),
		gen: new CryptoSecretGenerator(),
		clock,
		folderPicker: new NativeFolderPicker(),
		browser: new SystemBrowserOpener(),
	};
}
