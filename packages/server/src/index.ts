/** Op result models the dashboard renders (types only; re-exported from core). */
export type {
	CatalogCategory,
	CatalogListing,
	ConnectionInfo,
	DataObject,
	DataObjects,
	DataQueryResult,
	EnvPreview,
	EnvPreviewLine,
	ImportItem,
	ImportPreview,
	LinkEnvResult,
	LogLine,
	PersistMode,
	Progress,
	ProjectEntry,
	ProjectStatus,
	ProjectSummary,
	ServiceDefinition,
	ServiceDetail,
	ServicePatch,
	ServiceProblem,
	ServiceState,
	ServiceStatus,
	Snapshot,
	Stack,
	StackFile,
	StackServiceEntry,
	StatsSample,
	SystemInfo,
} from "@locainfra/core";
export {
	type App,
	createApp,
	createRuntime,
	type ServerDeps,
	type ServerRuntime,
} from "./app";
export type { ServerOps, ServerPorts } from "./deps";
export type { ApiError, OpAccepted } from "./models/common.model";
export { OP_ERROR_STATUS, TIMEOUT_CODE } from "./models/common.model";
export type { DataQueryBody } from "./modules/data/data.model";
export type { DoctorCheck, DoctorReport } from "./modules/doctor/doctor.model";
export {
	createDoctorRunner,
	type DoctorRunner,
	DoctorService,
} from "./modules/doctor/doctor.service";
export type {
	EnvQuery,
	WriteEnvBody,
} from "./modules/env/env.model";
export type {
	ImportBody,
	ImportPreviewBody,
} from "./modules/import/import.model";
export {
	LOG_PAUSE_BUFFERED_BYTES,
	WS_BACKPRESSURE_LIMIT,
} from "./modules/observer/backpressure";
export type {
	Channel,
	ChannelError,
	ClientMessage,
	LogBatch,
	ServerMessage,
	StatsBatch,
	StatusDelta,
} from "./modules/observer/observer.model";
export type { ObserverOptions } from "./modules/observer/observer.service";
export {
	type OpInfo,
	OpRegistry,
	type OpRegistryOptions,
} from "./modules/observer/op-registry";
export type {
	CreateProjectBody,
	DownQuery,
	PickedFolder,
	PickFolderBody,
	ProjectDetail,
} from "./modules/projects/projects.model";
export type {
	AddServiceBody,
	ConnectionQuery,
	DataCapability,
	LogTail,
	LogTailQuery,
	RemoveServiceQuery,
	RotateSecretBody,
	ServiceView,
	StatsReading,
} from "./modules/services/services.model";
export type { CreateSnapshotBody } from "./modules/snapshots/snapshots.model";
export type { SystemStatus } from "./modules/system/system.model";
export {
	type DashboardFile,
	dashboardUrl,
	type ProbeOptions,
	probeDashboard,
	type RunningDashboard,
	readDashboardFile,
} from "./runtime/dashboard-file";
export {
	DASHBOARD_HOSTNAME,
	type RunningServer,
	type StartServerOptions,
	startServer,
} from "./runtime/start-server";
