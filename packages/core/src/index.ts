/**
 * Public API of `@locastack/core`. The only barrel in the package (plus the
 * `./testing` entry): features import each other by module path.
 */

export { BUILTIN_CATALOG_FILES, BuiltinCatalogSource } from "./catalog/builtin";
export type { CatalogErrorOptions } from "./catalog/catalog.model";
export {
	CatalogError,
	ConfigValue,
	DATA_OBJECT_PLACEHOLDER,
	DATA_QUERY_PLACEHOLDER,
	IMPORT_ENV_TARGET_PATTERN,
	ServiceCategory,
	ServiceData,
	ServiceDataKind,
	ServiceDefinition,
	ServiceHealthcheck,
	ServiceImport,
	ServicePort,
	ServiceSecretOptions,
	ServiceSeed,
	ServiceSnippets,
	ServiceStudio,
	ServiceVolume,
	StudioPanel,
} from "./catalog/catalog.model";
export { serviceJsonSchema } from "./catalog/catalog.schema";
export type { CatalogSource } from "./catalog/catalog.source";
export type { CreateCatalogSourceOptions } from "./catalog/composite.source";
export {
	CompositeCatalogSource,
	createCatalogSource,
	mergeDefinitions,
} from "./catalog/composite.source";
export type { DirectoryCatalogSourceOptions } from "./catalog/directory.source";
export { DirectoryCatalogSource } from "./catalog/directory.source";
export type { LoadDefinitionOptions } from "./catalog/loader";
export {
	loadServiceDefinition,
	parseServiceDefinition,
} from "./catalog/loader";
export type { SafetyOptions } from "./catalog/validator";
export {
	checkCatalogReferences,
	checkDefinitionConsistency,
	checkDefinitionSafety,
	DEFAULT_ALLOWED_REGISTRIES,
	imageRegistry,
} from "./catalog/validator";
export {
	type CsvParse,
	parseCsv,
	parseRedisCsv,
} from "./data/csv";
export {
	buildQueryArgv,
	renderArgv,
	renderDefaultQuery,
	splitRedisWords,
} from "./data/query-argv";
export {
	type DerivedEnvLine,
	deriveEnv,
	deriveEnvLines,
	envKeyPrefix,
	isReservedEnvName,
	maskSecrets,
	primaryExportName,
	RESERVED_ENV_NAMES,
	RESERVED_ENV_PREFIXES,
} from "./env/deriver";
export { dotenvFormatter, quoteDotenvValue } from "./env/formats/dotenv";
export type {
	EnvFormat,
	EnvFormatter,
	EnvVars,
} from "./env/formats/env-formatter";
export { formatGroupedEnv, type GroupedEnvLine } from "./env/formats/grouped";
export { jsonFormatter } from "./env/formats/json";
export { ENV_FORMATTERS, getEnvFormatter } from "./env/formats/registry";
export { quoteShellValue, shellFormatter } from "./env/formats/shell";
export {
	LINKED_ENV_FILE_MODE,
	writeLinkedEnvFile,
} from "./env/link/link-file";
export {
	LINK_END_MARKER,
	LINK_START_MARKER,
	readMarkerBlock,
	writeMarkerBlock,
} from "./env/link/marker-writer";
export { addService } from "./ops/add-service.op";
export { catalogList, categorySlug } from "./ops/catalog-list.op";
export { createProject } from "./ops/create-project.op";
export { createSnapshot } from "./ops/create-snapshot.op";
export { deleteSnapshot } from "./ops/delete-snapshot.op";
export { discoverStack } from "./ops/discover-stack.op";
export * from "./ops/doctor/doctor.model";
export { runDoctor } from "./ops/doctor/run-doctor.op";
export { downProject } from "./ops/down-project.op";
export { downStack } from "./ops/down-stack.op";
export { envForStack } from "./ops/env-for-stack.op";
export { envPreview } from "./ops/env-preview.op";
export {
	connectionLabel,
	getConnection,
	SNIPPET_KEY_PLACEHOLDER,
} from "./ops/get-connection.op";
export { getService } from "./ops/get-service.op";
export { getSystemInfo } from "./ops/get-system-info.op";
export { importProject } from "./ops/import-project.op";
export { linkEnv } from "./ops/link-env.op";
export { listDataObjects } from "./ops/list-data-objects.op";
export { listProjects } from "./ops/list-projects.op";
export { listServices } from "./ops/list-services.op";
export { listSnapshots } from "./ops/list-snapshots.op";
export { loadProject } from "./ops/load-project.op";
export { mapComposeToCatalog } from "./ops/map-compose-to-catalog.op";
export type * from "./ops/ops.contract";
export {
	CatalogCategory,
	CatalogListing,
	ComposeImportPort,
	ComposeImportService,
	ConnectionDetail,
	ConnectionInfo,
	ConnectionSnippets,
	CreateSnapshotRequest,
	DATA_MAX_OBJECTS,
	DATA_QUERY_MAX_BYTES,
	DATA_QUERY_MAX_LENGTH,
	DATA_QUERY_MAX_ROWS,
	DATA_QUERY_TIMEOUT_MS,
	DataObject,
	DataObjects,
	DataQueryRequest,
	DataQueryResult,
	DEFAULT_MAC_RUNTIME,
	DOCKER_START_TIMEOUT_MS,
	EnvFormatModel,
	EnvPair,
	EnvPreview,
	EnvPreviewLine,
	IMPORT_MAX_SERVICES,
	IMPORT_SECRET_VALUE_PATTERN,
	IMPORT_YAML_MAX_BYTES,
	ImportItem,
	ImportPlan,
	ImportPreview,
	ImportSkipReason,
	LinkEnvResult,
	MASKED_SECRET,
	ParsedCompose,
	ProjectStatus,
	ProjectSummary,
	ResourceName,
	RotateSecretOptions,
	SECRET_VALUE_PATTERN,
	SEED_MAX_BYTES,
	SEED_TIMEOUT_MS,
	SETUP_INSTALLER_URLS,
	SETUP_STEP_TIMEOUT_MS,
	SecretValue,
	SecretValues,
	ServiceDetail,
	ServicePatch,
	ServiceProblem,
	ServiceState,
	ServiceStatus,
	ServiceVolumeInfo,
	SetupKind,
	SetupOptions,
	SetupPlan,
	Snapshot,
	SystemInfo,
} from "./ops/ops.model";
export {
	NO_SERVICES_MESSAGE,
	parseComposeForImport,
} from "./ops/parse-compose-for-import.op";
export {
	DEFAULT_IMPORT_PROJECT_NAME,
	previewImport,
} from "./ops/preview-import.op";
export { registerProject } from "./ops/register-project.op";
export { removeService } from "./ops/remove-service.op";
export { restartService } from "./ops/restart-service.op";
export { restoreSnapshot } from "./ops/restore-snapshot.op";
export {
	BAKED_SECRET_FIX,
	rotateSecret,
	WIPE_NEEDS_FORCE_FIX,
} from "./ops/rotate-secret.op";
export { COMMAND_TAG_COLUMN, runQuery } from "./ops/run-query.op";
export { seedService } from "./ops/seed-service.op";
export {
	buildSetupPlan,
	ROSETTA_BREW_REASON,
} from "./ops/setup/build-setup-plan.op";
export { planSetup } from "./ops/setup/plan-setup.op";
export {
	outputLines,
	ROSETTA_COLIMA_FIX,
	runSetupPlan,
	stepFailureFix,
} from "./ops/setup/run-setup-plan.op";
export {
	INTEL_COLIMA_FORMULAE,
	MAC_RUNTIMES,
	MANUAL_INSTALL_URLS,
	NATIVE_BREW_PREFIX,
	RUNTIME_LABELS,
	SETUP_STEP,
	type SetupStepId,
} from "./ops/setup/setup-steps";
export { startDockerRuntime } from "./ops/setup/start-docker-runtime.op";
export { startService } from "./ops/start-service.op";
export { statusForProject } from "./ops/status-for-project.op";
export { stopService } from "./ops/stop-service.op";
export {
	COMPOSE_ENV_FILE_NAME,
	SECRET_FILE_MODE,
	UP_WAIT_TIMEOUT_SEC,
} from "./ops/support/compose";
export { DEFAULT_ENV_FILE } from "./ops/support/env-lines";
export {
	MAX_SUGGESTION_PROBES,
	suggestFreePort,
} from "./ops/support/ports";
export {
	checkSeedFile,
	type SeedFile,
	verifySeedMounts,
} from "./ops/support/seed-file";
export { checkSecretValues } from "./ops/support/service-input";
export {
	classifyContainer,
	PORT_IN_USE_PATTERN,
	STOP_EXIT_CODES,
} from "./ops/support/service-status";
export {
	majorVersion,
	snapshotMismatch,
} from "./ops/support/snapshots";
export { unregisterProject } from "./ops/unregister-project.op";
export { upProject } from "./ops/up-project.op";
export { upStack } from "./ops/up-stack.op";
export { applyServicePatch, updateService } from "./ops/update-service.op";
export * from "./paths/layout";
export type {
	ComposeDownInput,
	ComposeInfoPort,
	ComposePsInput,
	ComposeRemoveInput,
	ComposeServicesInput,
	ComposeTarget,
	ComposeUpInput,
	LifecycleRunner,
} from "./ports/compose.port";
export { ComposePublisher, ComposeServiceStatus } from "./ports/compose.port";
export type {
	BrowserOpener,
	FolderPicker,
	FolderPickOptions,
} from "./ports/desktop.port";
export type {
	ContainerFilter,
	ContainerInspector,
	ContainerReader,
	ContainerStreams,
	DaemonWaiter,
	DockerInfoPort,
	EventFilter,
	LogOptions,
	SocketLocator,
} from "./ports/docker.port";
export {
	ContainerDetails,
	ContainerHealth,
	ContainerSummary,
	DockerEvent,
	DockerInfo,
	LogLine,
	LogStream,
	PortMapping,
	StatsSample,
} from "./ports/docker.port";
export type {
	ContainerExec,
	ExecOptions,
	ExecResult,
} from "./ports/exec.port";
export type {
	Clock,
	DirectoryLister,
	FileInfo,
	FileStore,
	PortProbe,
	SecretGenerator,
	WriteTextOptions,
} from "./ports/files.port";
export type { OpJournal } from "./ports/op-journal.port";
export { OpFinish, OpStart, OpStatus } from "./ports/op-journal.port";
export type { Paths } from "./ports/paths.port";
export type { PlatformInspector } from "./ports/platform.port";
export {
	PlatformFacts,
	PlatformOs,
	PlatformSummary,
	RuntimeProvider,
} from "./ports/platform.port";
export type {
	ProcessRunner,
	ProcessRunOptions,
	ProcessRunResult,
} from "./ports/process.port";
export { CommandStep, RemoteScript } from "./ports/process.port";
export type { SecretStore } from "./ports/secrets.port";
export type { SnapshotIndex, VolumeArchiver } from "./ports/snapshot.port";
export {
	SNAPSHOT_FILE_EXTENSION,
	SNAPSHOT_ID_PATTERN,
	SNAPSHOT_NAME_PATTERN,
	SNAPSHOT_SECRETS_EXTENSION,
	SnapshotRecord,
	snapshotArchivePath,
	snapshotSecretsPath,
	snapshotsDir,
} from "./ports/snapshot.port";
export type { StateReader, StateWriter } from "./ports/state.port";
export {
	createEmptyState,
	ProjectEntry,
	RegistryState,
	StackState,
	StateFile,
} from "./ports/state.port";
export {
	type ComposeBindMount,
	type ComposeDependency,
	type ComposeDocument,
	type ComposeHealthcheck,
	type ComposeNamedResource,
	type ComposeService,
	containerName,
	renderCompose,
	renderComposeEnvFile,
	toComposeDocument,
} from "./render/compose-renderer";
export {
	LABEL_CATALOG_ID,
	LABEL_INSTANCE,
	LABEL_PREFIX,
	LABEL_SERVICE,
	LABEL_STACK,
	LABEL_TYPE,
	LABEL_VERSION,
} from "./render/labels";
export {
	type ComposeEscaper,
	collectStackSecrets,
	createComposeEscaper,
	MIN_REFERENCED_SECRET_LENGTH,
	SECRET_VAR_PREFIX,
	secretVarName,
} from "./render/secret-refs";
export { type PlannedService, planStack } from "./resolve/plan";
export {
	allocatePorts,
	MAX_PORT_ALLOCATION_ATTEMPTS,
	type PortAllocatorDeps,
	type PortAllocatorInput,
} from "./resolve/ports/allocator";
export {
	type PortOwner,
	portsInRange,
	portsReservedByOtherStacks,
} from "./resolve/ports/ranges";
export { type ProvisionDeps, provisionStack } from "./resolve/provision";
export type {
	ResolvedHealthcheck,
	ResolvedSeedMount,
	ResolvedService,
	ResolvedStack,
	ResolvedVolume,
} from "./resolve/resolved.model";
export {
	type ResolveStackInput,
	resolveStack,
	UNPROVISIONED_PORT,
	UNPROVISIONED_SECRET,
} from "./resolve/resolver";
export {
	ensureSecrets,
	instanceSecretKey,
	SECRET_BYTES,
	type SecretEnsurerDeps,
	type SecretEnsurerInput,
	uniqueSecretNames,
} from "./resolve/secrets/generator";
export { serviceTemplateContext } from "./resolve/service-context";
export {
	formatCommand,
	formatCommandStep,
	quoteShellArg,
} from "./shared/command-format";
export { JSON_SCHEMA_DRAFT, publishedJsonSchema } from "./shared/json-schema";
export {
	ioErrorFrom,
	isOpError,
	OP_ERROR_CODES,
	OpError,
	type OpErrorCode,
	type OpErrorOptions,
} from "./shared/op-error";
export {
	type JournalEntry,
	journalProgress,
	journalResult,
} from "./shared/op-journal";
export {
	errorProgress,
	terminalProgress,
	withOpId,
	withService,
	withTimestamp,
} from "./shared/progress";
export {
	Progress,
	ProgressError,
	ProgressKind,
	toProgressError,
} from "./shared/progress.model";
export { err, ok, type Result } from "./shared/result";
export { subStep } from "./shared/sub-progress";
export {
	compareVersions,
	isAtLeast,
	MIN_COMPOSE_VERSION,
	MIN_DOCKER_API_VERSION,
	parseVersion,
	RECOMMENDED_COMPOSE_VERSION,
} from "./shared/version";
export type { SchemaIssue, YamlSource } from "./shared/yaml-schema";
export {
	decodeWithSchema,
	formatIssues,
	readYamlSource,
	schemaIssues,
} from "./shared/yaml-schema";
export { emptyStackFile, findProjectStackFile } from "./stack/discovery";
export type { LoadStackInput } from "./stack/loader";
export { loadStack, parseStackFile, stackErrorToOpError } from "./stack/loader";
export {
	type ContainerNameCandidate,
	type ContainerNameClash,
	checkProjectOwner,
	claimProjectName,
	containerNameClashError,
	findContainerNameClash,
	findProjectEntry,
	type ProjectClaimDeps,
	type ProjectOwnerCheckDeps,
	registeredProjectRoot,
} from "./stack/project-registry";
export type { StackErrorOptions } from "./stack/stack.model";
export {
	DEFAULT_PERSIST_MODE,
	NAME_PATTERN,
	PersistMode,
	PROJECT_STACK_FILE_NAME,
	SEED_PATH_PATTERN,
	SeedPath,
	Stack,
	StackError,
	StackFile,
	StackLink,
	StackServiceEntry,
} from "./stack/stack.model";
export { stackJsonSchema } from "./stack/stack.schema";
export {
	addStackService,
	removeStackService,
	renderStackFile,
	STACK_SCHEMA_COMMENT,
	setStackService,
	updateStackFile,
} from "./stack/writer";
export {
	renderTemplate,
	renderTemplateList,
	renderTemplateRecord,
	templatePaths,
} from "./template/template";
export type {
	TemplateContext,
	TemplateIssue,
	TemplateIssueReason,
	TemplateServiceContext,
} from "./template/template.model";
export { TemplateError } from "./template/template.model";
