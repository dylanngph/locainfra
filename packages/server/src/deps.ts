import type {
	AddService,
	CatalogList,
	CatalogSource,
	Clock,
	ComposeInfoPort,
	ContainerExec,
	ContainerInspector,
	ContainerReader,
	ContainerStreams,
	CreateProject,
	CreateSnapshot,
	DeleteSnapshot,
	DockerInfoPort,
	DownProject,
	EnvPreviewOp,
	FileStore,
	FolderPicker,
	GetConnection,
	GetService,
	GetSystemInfo,
	ImportProject,
	LifecycleRunner,
	LinkEnv,
	ListDataObjects,
	ListProjects,
	ListSnapshots,
	LoadProject,
	OpJournal,
	Paths,
	PortProbe,
	PreviewImport,
	RegisterProject,
	RemoveService,
	RestartService,
	RestoreSnapshot,
	RotateSecret,
	RunDoctor,
	RunQuery,
	SecretGenerator,
	SecretStore,
	SeedService,
	SnapshotIndex,
	SocketLocator,
	StartService,
	StateReader,
	StateWriter,
	StatusForProject,
	StopService,
	UnregisterProject,
	UpdateService,
	UpProject,
	VolumeArchiver,
} from "@locainfra/core";

/**
 * Every core operation the server calls. Injected (rather than imported) so
 * the composition root decides the implementation and tests can stub any op.
 * Keys are the op function names exported by `@locainfra/core`.
 */
export interface ServerOps {
	/** Diagnostics (`GET /api/doctor`). */
	readonly runDoctor: RunDoctor;
	/** Docker/compose versions (`GET /api/system`). */
	readonly getSystemInfo: GetSystemInfo;
	/** Catalog listing (`GET /api/catalog`). */
	readonly catalogList: CatalogList;
	/** Project summaries (`GET /api/projects`). */
	readonly listProjects: ListProjects;
	/** Registers an existing folder (`POST /api/projects`). */
	readonly registerProject: RegisterProject;
	/** Creates a folder + `locainfra.yaml` (`POST /api/projects`). */
	readonly createProject: CreateProject;
	/** Unregisters (`DELETE /api/projects/:project`). */
	readonly unregisterProject: UnregisterProject;
	/** Loads a registered project's stack file. */
	readonly loadProject: LoadProject;
	/** Start all (`POST …/up`). */
	readonly upProject: UpProject;
	/** Stop all (`POST …/down`). */
	readonly downProject: DownProject;
	/** Live status of a project (REST detail and the `status:` channel). */
	readonly statusForProject: StatusForProject;
	/** One service's detail. */
	readonly getService: GetService;
	/** Add & start. */
	readonly addService: AddService;
	/** Remove a service. */
	readonly removeService: RemoveService;
	/** Patch a service (e.g. "Use port N"). */
	readonly updateService: UpdateService;
	/** Start one service. */
	readonly startService: StartService;
	/** Stop one service. */
	readonly stopService: StopService;
	/** Restart one service. */
	readonly restartService: RestartService;
	/** Environment preview. */
	readonly envPreview: EnvPreviewOp;
	/** Write the env file marker block. */
	readonly linkEnv: LinkEnv;
	/** Connect tab data. */
	readonly getConnection: GetConnection;
	/** Data tab object list (`GET …/data`). */
	readonly listDataObjects: ListDataObjects;
	/** Data tab query runner (`POST …/data/query`). */
	readonly runQuery: RunQuery;
	/** Snapshots of a service (`GET …/snapshots`). */
	readonly listSnapshots: ListSnapshots;
	/** Archive a service's volume (`POST …/snapshots`). */
	readonly createSnapshot: CreateSnapshot;
	/** Replace a volume's contents with a snapshot (`POST …/snapshots/:id/restore`). */
	readonly restoreSnapshot: RestoreSnapshot;
	/** Delete a snapshot file and row (`DELETE …/snapshots/:id`). */
	readonly deleteSnapshot: DeleteSnapshot;
	/** Re-apply a service's seed file (`POST …/seed`). */
	readonly seedService: SeedService;
	/** New value for one secret, then recreate (`PATCH …/secrets/:key/rotate`). */
	readonly rotateSecret: RotateSecret;
	/** Parse and map a compose file, writing nothing (`POST /api/import/preview`). */
	readonly previewImport: PreviewImport;
	/** Create a project from a reviewed import preview (`POST /api/import`). */
	readonly importProject: ImportProject;
}

/**
 * Every port the server's ops and observer need: the union of the op `*Deps`
 * slices plus the observer's streams and the desktop folder picker. Field
 * names match core's `ops.contract.ts`, so this object is passed straight to
 * any op.
 */
export interface ServerPorts {
	/** `locainfra.db` state store (project registry, pinned ports). */
	readonly state: StateReader & StateWriter;
	/** Text file access. */
	readonly files: FileStore;
	/** Per-project secrets. */
	readonly secrets: SecretStore;
	/** Filesystem layout (`paths.stateDir` holds `dashboard.json`). */
	readonly paths: Paths;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
	/** 127.0.0.1 bind probe. */
	readonly probe: PortProbe;
	/** Secret generator. */
	readonly gen: SecretGenerator;
	/** Time source. */
	readonly clock: Clock;
	/** `docker compose` lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** `docker compose` version. */
	readonly compose: ComposeInfoPort;
	/** Engine API daemon info. */
	readonly docker: DockerInfoPort;
	/** Docker socket discovery. */
	readonly socket: SocketLocator;
	/** Container listing. */
	readonly containers: ContainerReader;
	/** Container inspect. */
	readonly inspector: ContainerInspector;
	/** Logs, stats and events streams (observer). */
	readonly streams: ContainerStreams;
	/** Native folder chooser (New project). */
	readonly folderPicker: FolderPicker;
	/** `docker exec` (Data tab queries, seeding). */
	readonly exec: ContainerExec;
	/** Volume tar/untar with a `--rm` helper container (snapshots). */
	readonly archiver: VolumeArchiver;
	/** Snapshot index (SQLite `snapshots` table). */
	readonly snapshots: SnapshotIndex;
	/** Operation history (SQLite `ops` table); every `202 { opId }` op with a project is recorded. */
	readonly journal: OpJournal;
}
