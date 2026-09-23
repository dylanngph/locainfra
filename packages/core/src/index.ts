/**
 * Public API of `@locainfra/core`. The only barrel in the package (plus the
 * `./testing` entry): features import each other by module path.
 */

export { BUILTIN_CATALOG_FILES, BuiltinCatalogSource } from "./catalog/builtin";
export type { CatalogErrorOptions } from "./catalog/catalog.model";
export {
	CatalogError,
	ConfigValue,
	ServiceCategory,
	ServiceDefinition,
	ServiceHealthcheck,
	ServicePort,
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
	deriveEnv,
	isReservedEnvName,
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
export { jsonFormatter } from "./env/formats/json";
export { ENV_FORMATTERS, getEnvFormatter } from "./env/formats/registry";
export { quoteShellValue, shellFormatter } from "./env/formats/shell";
export {
	LINK_END_MARKER,
	LINK_START_MARKER,
	readMarkerBlock,
	writeMarkerBlock,
} from "./env/link/marker-writer";
export { discoverStack } from "./ops/discover-stack.op";
export * from "./ops/doctor/doctor.model";
export { DOCTOR_CHECK_IDS, runDoctor } from "./ops/doctor/run-doctor.op";
export { downStack } from "./ops/down-stack.op";
export { envForStack } from "./ops/env-for-stack.op";
export type * from "./ops/ops.contract";
export {
	COMPOSE_ENV_FILE_NAME,
	SECRET_FILE_MODE,
	UP_WAIT_TIMEOUT_SEC,
	upStack,
} from "./ops/up-stack.op";
export * from "./paths/layout";
export type {
	ComposeDownInput,
	ComposeInfoPort,
	ComposePsInput,
	ComposeTarget,
	ComposeUpInput,
	LifecycleRunner,
} from "./ports/compose.port";
export { ComposePublisher, ComposeServiceStatus } from "./ports/compose.port";
export type {
	ContainerFilter,
	ContainerReader,
	DockerInfoPort,
	SocketLocator,
} from "./ports/docker.port";
export {
	ContainerHealth,
	ContainerSummary,
	DockerInfo,
	PortMapping,
} from "./ports/docker.port";
export type {
	Clock,
	DirectoryLister,
	FileStore,
	PortProbe,
	SecretGenerator,
	WriteTextOptions,
} from "./ports/files.port";
export type { Paths } from "./ports/paths.port";
export type { SecretStore } from "./ports/secrets.port";
export type { StateReader, StateWriter } from "./ports/state.port";
export {
	createEmptyState,
	ProjectEntry,
	RegistryState,
	StackState,
	StateFile,
} from "./ports/state.port";
export {
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
	LABEL_PREFIX,
	LABEL_SERVICE,
	LABEL_STACK,
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
	ResolvedService,
	ResolvedStack,
	ResolvedVolume,
} from "./resolve/resolved.model";
export { type ResolveStackInput, resolveStack } from "./resolve/resolver";
export {
	ensureSecrets,
	SECRET_BYTES,
	type SecretEnsurerDeps,
	type SecretEnsurerInput,
	uniqueSecretNames,
} from "./resolve/secrets/generator";
export { JSON_SCHEMA_DRAFT, publishedJsonSchema } from "./shared/json-schema";
export {
	isOpError,
	OP_ERROR_CODES,
	OpError,
	type OpErrorCode,
	type OpErrorOptions,
} from "./shared/op-error";
export {
	errorProgress,
	terminalProgress,
	withTimestamp,
} from "./shared/progress";
export {
	Progress,
	ProgressError,
	ProgressKind,
	toProgressError,
} from "./shared/progress.model";
export { err, ok, type Result } from "./shared/result";
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
	checkProjectOwner,
	claimProjectName,
	type ProjectClaimDeps,
	type ProjectOwnerCheckDeps,
	registeredProjectRoot,
} from "./stack/project-registry";
export type { StackErrorOptions } from "./stack/stack.model";
export {
	GLOBAL_STACK_FILE_NAME,
	GLOBAL_STACK_NAME,
	PROJECT_STACK_FILE_NAME,
	Stack,
	StackError,
	StackFile,
	StackKind,
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
