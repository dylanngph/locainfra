/**
 * Type-only signatures of every operation (use-case). One op per file in this
 * folder (`<name>.op.ts`) implements one type below. Each op's `Deps` lists
 * only the ports it needs (interface segregation); composition roots
 * (`packages/cli/src/composition.ts`, `packages/server/src/app.ts`) pass
 * concrete engines.
 *
 * Conventions:
 * - Ops that touch containers stream `AsyncIterable<Progress>` ending with
 *   exactly one `done` or `error` event; no event carries a secret value.
 * - Other ops return `Result<T, OpError>` and never throw for expected failures.
 * - Projects are addressed by registered name (`project`), services by
 *   instance name (`name`).
 */
import type { ServiceDefinition } from "../catalog/catalog.model";
import type { CatalogSource } from "../catalog/catalog.source";
import type { EnvFormat } from "../env/formats/env-formatter";
import type { ComposeInfoPort, LifecycleRunner } from "../ports/compose.port";
import type {
	ContainerInspector,
	ContainerReader,
	DaemonWaiter,
	DockerInfoPort,
	SocketLocator,
} from "../ports/docker.port";
import type { ContainerExec } from "../ports/exec.port";
import type {
	Clock,
	FileStore,
	PortProbe,
	SecretGenerator,
} from "../ports/files.port";
import type { Paths } from "../ports/paths.port";
import type {
	PlatformFacts,
	PlatformInspector,
	RuntimeProvider,
} from "../ports/platform.port";
import type { CommandStep, ProcessRunner } from "../ports/process.port";
import type { SecretStore } from "../ports/secrets.port";
import type { SnapshotIndex, VolumeArchiver } from "../ports/snapshot.port";
import type {
	ProjectEntry,
	StateReader,
	StateWriter,
} from "../ports/state.port";
import type { OpError } from "../shared/op-error";
import type { Progress } from "../shared/progress.model";
import type { Result } from "../shared/result";
import type { PersistMode, Stack, StackFile } from "../stack/stack.model";
import type { DoctorReport } from "./doctor/doctor.model";
import type {
	CatalogListing,
	ConnectionInfo,
	DataObjects,
	DataQueryResult,
	EnvPreview,
	ImportItem,
	ImportPlan,
	ImportPreview,
	LinkEnvResult,
	ParsedCompose,
	ProjectStatus,
	ProjectSummary,
	RotateSecretOptions,
	SecretValues,
	ServiceDetail,
	ServicePatch,
	SetupOptions,
	SetupPlan,
	Snapshot,
	SystemInfo,
} from "./ops.model";

// ---------------------------------------------------------------------------
// Dependency slices (compose them per op; never pass more than an op needs)
// ---------------------------------------------------------------------------

/** Reads the project registry and project files. */
export interface ProjectReadDeps {
	/** Persisted state (`projects` registry). */
	readonly state: StateReader;
	/** File access (`<root>/locastack.yaml`). */
	readonly files: FileStore;
}

/** Writes the project registry and project files. */
export interface ProjectWriteDeps extends ProjectReadDeps {
	/** Persisted state (`projects` registry is written here). */
	readonly state: StateReader & StateWriter;
}

/** Evaluates a stack without mutating anything (pinned ports, stored secrets). */
export interface ProjectViewDeps extends ProjectReadDeps {
	/** Stored secrets (read only). */
	readonly secrets: SecretStore;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
}

/** Resolves and renders a stack: pins ports, generates secrets, writes compose files. */
export interface ResolveDeps extends ProjectWriteDeps {
	/** Secret persistence. */
	readonly secrets: SecretStore;
	/** Host port probe. */
	readonly probe: PortProbe;
	/** Secret generator. */
	readonly gen: SecretGenerator;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Time source. */
	readonly clock: Clock;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
}

/** Runs compose lifecycle commands. */
export interface LifecycleDeps {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Compose plugin version (checked against `MIN_COMPOSE_VERSION` before mutating). */
	readonly compose: ComposeInfoPort;
}

/** Reads containers from the Engine API. */
export interface ContainerViewDeps {
	/** Container listing by label. */
	readonly containers: ContainerReader;
	/** Container inspect (startedAt, State.Error for port conflicts). */
	readonly inspector: ContainerInspector;
	/** Probes the pinned port of a non-running service to report `port-conflict`. */
	readonly probe: PortProbe;
}

/** Input naming a registered project. */
export interface ProjectRef {
	/** Registered project name. */
	readonly project: string;
}

/** Input naming one service instance of a registered project. */
export interface ServiceRef extends ProjectRef {
	/** Service instance name (key in `services`). */
	readonly name: string;
}

// ---------------------------------------------------------------------------
// Diagnostics and system
// ---------------------------------------------------------------------------

/** Ports required by {@link RunDoctor}. */
export interface RunDoctorDeps {
	/** Engine API daemon info. */
	readonly docker: DockerInfoPort;
	/** Compose plugin version. */
	readonly compose: ComposeInfoPort;
	/** Docker socket discovery. */
	readonly socket: SocketLocator;
	/** Time source for `generatedAt`. */
	readonly clock: Clock;
	/**
	 * Machine facts: `docker.cli`, `docker.group` and `homebrew` checks, the
	 * report's `platform` and `setupNeeded`.
	 */
	readonly platform: PlatformInspector;
}

/**
 * Diagnoses Docker: the checks of `DOCTOR_CHECK` in that order (`docker.api`
 * only when the daemon answers, `compose.version` only when the plugin
 * works, `docker.group` on Linux, `homebrew` on macOS), plus `platform` (the
 * public part of `PlatformFacts`) and `setupNeeded` (see `SetupNeeded`).
 * Never throws; failures become `fail` checks, a failed inspection an
 * `other`-OS platform with `setupNeeded: "unsupported"` when a check fails.
 */
export type RunDoctor = (deps: RunDoctorDeps) => Promise<DoctorReport>;

/** Ports required by {@link GetSystemInfo}. */
export interface GetSystemInfoDeps {
	/** Engine API daemon info (a rejection becomes `docker: null`). */
	readonly docker: DockerInfoPort;
	/** Compose plugin version. */
	readonly compose: ComposeInfoPort;
}

/** Docker and compose versions for the header status dot. Never throws. */
export type GetSystemInfo = (deps: GetSystemInfoDeps) => Promise<SystemInfo>;

// ---------------------------------------------------------------------------
// Docker setup (`locastack setup`, doctor/bare `locastack` offer, dashboard Start Docker)
// ---------------------------------------------------------------------------

/**
 * Pure planner: turns machine facts and a doctor report into the commands
 * that fix the failing checks, cheapest remedy first (start a stopped
 * runtime before installing anything). Runs nothing and never throws.
 *
 * - `report.ok` → `kind: "none"`, no steps.
 * - `win32`/`other` → `unsupported` with manual instructions in `postNotes`.
 * - macOS: Homebrew missing and needed → download `SETUP_INSTALLER_URLS.homebrew`
 *   to `tmpDir` (a `remoteScript` step), then `/bin/bash <file>` (attached);
 *   later steps call `<brewPrefix>/bin/brew` by absolute path (prefix
 *   `/opt/homebrew` on arm64, `/usr/local` on x64 when not yet installed).
 *   Colima (default): `brew install colima docker docker-compose`,
 *   `mkdir -p <home>/.docker/cli-plugins`, `ln -sfn <prefix>/opt/docker-compose/bin/docker-compose <home>/.docker/cli-plugins/docker-compose`,
 *   then `colima start` (or `brew services start colima` with `startAtLogin`).
 *   Docker Desktop: `brew install --cask docker`, `open -a Docker` (note: the
 *   app finishes setup in its own window). OrbStack: `brew install --cask orbstack`,
 *   `open -a OrbStack`. Compose missing/too old with a working daemon: only
 *   the compose install/upgrade and link steps.
 * - Linux: stopped `docker-engine` → `sudo systemctl start docker` (when
 *   `hasSystemd`, else `sudo service docker start`); nothing installed →
 *   `curl -fsSL https://get.docker.com -o <tmpDir>/get-docker.sh`
 *   (`remoteScript`), `sudo sh <tmpDir>/get-docker.sh`, `sudo systemctl enable --now docker`
 *   (with systemd; else `sudo service docker start`), `sudo usermod -aG docker <username>`
 *   (+ `requiresRelogin`). Docker Desktop for Linux: start only
 *   (`systemctl --user start docker-desktop`). Stopped engine and not in
 *   the group → start + usermod; running engine refusing the user → the
 *   usermod step only. The curl download uses `--create-dirs`. `sudo` is dropped when
 *   `isRoot`.
 *
 * Unknown/unsuitable `options.runtime` for the OS → `unsupported` with the
 * reason. `alternatives` lists the other macOS runtimes for install plans and
 * the other installed runtimes for start plans. Several installed runtimes:
 * the one the docker context names starts, else Docker Desktop, OrbStack,
 * Colima (macOS) / Docker Engine, Docker Desktop (Linux). `DOCKER_HOST` set
 * and not answering → `unsupported` unless its unix socket belongs to an
 * installed runtime (then only that one starts). A socket refusing the user
 * (Linux, EACCES) is a running engine: `usermod` only. Homebrew not on PATH
 * (not installed yet, or `brewOnPath: false`) → brew-installed binaries are
 * called by absolute path and `pathAdditions` names the prefix. A `docker`
 * CLI already on PATH is kept (no `docker` formula) on a Colima install.
 */
export type BuildSetupPlan = (
	facts: PlatformFacts,
	report: DoctorReport,
	options: SetupOptions,
) => SetupPlan;

/** Ports required by {@link PlanSetup}. */
export interface PlanSetupDeps {
	/** Machine facts. */
	readonly platform: PlatformInspector;
	/** Doctor ports (run when {@link PlanSetupInput.report} is absent). */
	readonly doctor: RunDoctorDeps;
}

/** Input of {@link PlanSetup}. */
export interface PlanSetupInput extends SetupOptions {
	/** A fresh doctor report to reuse (bare `locastack` and `doctor` already ran it). */
	readonly report?: DoctorReport;
}

/**
 * Inspects the platform, runs doctor (unless `report` is given) and returns
 * {@link BuildSetupPlan}'s plan. Executes nothing. Never throws: an
 * inspection failure yields `kind: "unsupported"` with the reason.
 */
export type PlanSetup = (
	deps: PlanSetupDeps,
	input: PlanSetupInput,
) => Promise<SetupPlan>;

/** Ports required by {@link RunSetupPlan}. */
export interface RunSetupPlanDeps {
	/** Runs each step (the only port that installs or starts anything). */
	readonly runner: ProcessRunner;
	/** Waits for the daemon after the last step. */
	readonly waiter: DaemonWaiter;
	/** Doctor ports for the final re-check. */
	readonly doctor: RunDoctorDeps;
}

/** What {@link RunSetupPlanInput.beforeStep} decides for the next step. */
export type SetupStepDecision = "run" | "abort";

/** Input of {@link RunSetupPlan}. */
export interface RunSetupPlanInput {
	/** The plan the user consented to (unchanged from what was shown). */
	readonly plan: SetupPlan;
	/**
	 * `true` from a terminal (`locastack setup`): every step inherits stdio.
	 * `false` (server): output is captured and streamed as `log` events, and a
	 * plan with `needsTerminal` fails first with `SETUP_NEEDS_TERMINAL`.
	 */
	readonly attached: boolean;
	/**
	 * Called before each step; the CLI uses it to offer the inspect step
	 * after a `remoteScript` download ("Downloaded to …; inspect with: …;
	 * run it?"). Absent = run every step. `abort` ends with `SETUP_CANCELLED`.
	 */
	readonly beforeStep?: (
		step: CommandStep,
		index: number,
		plan: SetupPlan,
	) => Promise<SetupStepDecision>;
	/** Aborts the running step and the wait (`SETUP_CANCELLED`). */
	readonly signal?: AbortSignal;
	/** Daemon wait deadline (default `DOCKER_START_TIMEOUT_MS`). */
	readonly waitTimeoutMs?: number;
}

/**
 * Executes a plan's steps in order: a `step` event per command (message:
 * its title), captured output as `log` events when not attached, then stops
 * at the first non-zero exit with `SETUP_STEP_FAILED` (details: `stepId`,
 * `exitCode`, `stepTimedOut`, `fix` with the manual remedy). After the last
 * step it waits for the daemon (skipped when the plan has
 * `requiresRelogin`: this process cannot reach the socket before a new
 * login), re-runs doctor and ends with `done` ("Docker is ready: <engine>"
 * plus `postNotes`, or the re-login explanation with `requiresRelogin`) or `error` (`DOCKER_START_TIMEOUT`, or
 * the first failing check's fix as `DOCKER_UNREACHABLE`/`COMPOSE_MISSING`/
 * `COMPOSE_TOO_OLD`; both fixes end with the plan's `postNotes`). Before the
 * wait, `plan.pathAdditions` is prepended to this process's PATH
 * (`ProcessRunner.prependPath`). A `none` plan yields only `done`; an `unsupported`
 * plan only `error` (`SETUP_UNSUPPORTED`). Exactly one terminal event.
 */
export type RunSetupPlan = (
	deps: RunSetupPlanDeps,
	input: RunSetupPlanInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link StartDockerRuntime}. */
export type StartDockerRuntimeDeps = PlanSetupDeps & RunSetupPlanDeps;

/** Input of {@link StartDockerRuntime}. */
export interface StartDockerRuntimeInput {
	/** Runtime to start when several are installed (default: the planner's choice). */
	readonly provider?: RuntimeProvider;
	/** See {@link RunSetupPlanInput.attached} (the server passes `false`). */
	readonly attached: boolean;
	/** Aborts the start and the wait. */
	readonly signal?: AbortSignal;
}

/**
 * The `start` subset of setup (dashboard Start Docker): plans with
 * {@link PlanSetup}; `kind: "none"` → `done` ("Docker is already running");
 * `install` → `error` `DOCKER_NOT_INSTALLED` (fix: run `locastack setup`);
 * `unsupported` → `SETUP_UNSUPPORTED`; `start` → {@link RunSetupPlan} (a
 * sudo start, e.g. `systemctl` on Linux, fails with `SETUP_NEEDS_TERMINAL`
 * when not attached, fix naming the exact command). Never installs anything.
 */
export type StartDockerRuntime = (
	deps: StartDockerRuntimeDeps,
	input: StartDockerRuntimeInput,
) => AsyncIterable<Progress>;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Ports required by {@link CatalogList}. */
export interface CatalogListDeps {
	/** Merged catalog. */
	readonly catalog: CatalogSource;
}

/**
 * Every catalog definition (sorted by name) plus the filter categories, one
 * per distinct `categoryLabel ?? category`, in first-appearance order.
 * `INVALID_CATALOG` when the catalog fails to load.
 */
export type CatalogList = (
	deps: CatalogListDeps,
) => Promise<Result<CatalogListing, OpError>>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Ports required by {@link ListProjects}. */
export interface ListProjectsDeps extends ProjectReadDeps {
	/** Container listing (running / error counts by `locastack.stack` label). */
	readonly containers: ContainerReader;
}

/**
 * One summary per registered project, in registration order. A project whose
 * folder or file is missing or invalid still appears, with `issue` set.
 * `cpuPercent`/`memBytes` are 0 (the server overlays observer stats).
 */
export type ListProjects = (
	deps: ListProjectsDeps,
) => Promise<Result<ProjectSummary[], OpError>>;

/** Input of {@link RegisterProject}. */
export interface RegisterProjectInput {
	/** Project name; must equal the `name` in `<root>/locastack.yaml`. */
	readonly name: string;
	/** Absolute project folder containing `locastack.yaml`. */
	readonly root: string;
}

/**
 * Registers an existing project folder in `state.json`. `STACK_NOT_FOUND`
 * when `<root>/locastack.yaml` is missing, `INVALID_STACK` when invalid,
 * `INVALID_INPUT` when `name` differs from the file's name, `PROJECT_EXISTS`
 * when another folder holds the name or a container name would collide.
 * Re-registering the same folder is a no-op success.
 */
export type RegisterProject = (
	deps: ProjectWriteDeps,
	input: RegisterProjectInput,
) => Promise<Result<ProjectEntry, OpError>>;

/** Input of {@link CreateProject}. */
export interface CreateProjectInput {
	/** Project name (`^[a-z][a-z0-9-]*$`). */
	readonly name: string;
	/** Absolute project folder; created when missing (default in the UI: `~/Developer/<name>`). */
	readonly root: string;
	/** Initial services (written as-is; nothing is started). */
	readonly services?: StackFile["services"];
}

/**
 * Creates the folder (if needed) and `<root>/locastack.yaml`, then registers
 * it. `PROJECT_EXISTS` when the name is registered or the file already
 * exists (callers register an existing file with {@link RegisterProject});
 * `INVALID_INPUT` for a bad name or a relative root.
 */
export type CreateProject = (
	deps: ProjectWriteDeps,
	input: CreateProjectInput,
) => Promise<Result<Stack, OpError>>;

/** Ports required by {@link UnregisterProject}. */
export interface UnregisterProjectDeps {
	/** Persisted state (`projects` registry is written here). */
	readonly state: StateReader & StateWriter;
}

/**
 * Removes a project from `state.json` only: containers, volumes, secrets and
 * the folder are left alone. `PROJECT_NOT_FOUND` when not registered.
 */
export type UnregisterProject = (
	deps: UnregisterProjectDeps,
	input: ProjectRef,
) => Promise<Result<ProjectEntry, OpError>>;

/**
 * Loads and validates a registered project's `locastack.yaml`.
 * `PROJECT_NOT_FOUND` when not registered, `STACK_NOT_FOUND` when the file is
 * gone, `INVALID_STACK` when it does not validate.
 */
export type LoadProject = (
	deps: ProjectReadDeps,
	input: ProjectRef,
) => Promise<Result<Stack, OpError>>;

/** Ports required by {@link UpProject}. */
export type UpProjectDeps = ResolveDeps & LifecycleDeps;

/** Input of {@link UpProject}. */
export interface UpProjectInput extends ProjectRef {
	/** Limit to these instance names (all when omitted). */
	readonly services?: readonly string[];
}

/** {@link LoadProject} then {@link UpStack}: resolve, render, `compose up --wait`. */
export type UpProject = (
	deps: UpProjectDeps,
	input: UpProjectInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link DownProject}. */
export interface DownProjectDeps extends ProjectReadDeps {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Filesystem layout. */
	readonly paths: Paths;
}

/** Input of {@link DownProject}. */
export interface DownProjectInput extends ProjectRef {
	/** Also remove named volumes (destructive; callers confirm first). */
	readonly volumes?: boolean;
}

/** {@link LoadProject} then {@link DownStack}. */
export type DownProject = (
	deps: DownProjectDeps,
	input: DownProjectInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link StatusForProject}. */
export type StatusForProjectDeps = ProjectViewDeps & ContainerViewDeps;

/**
 * Live status of every service of a project, joined from the stack file,
 * pinned ports, catalog and containers (label `locastack.stack=<project>`).
 * A service whose pinned port is busy while its container is not running, or
 * whose container reports "port is already allocated", is `port-conflict`
 * with `problem.suggestedPort` set.
 */
export type StatusForProject = (
	deps: StatusForProjectDeps,
	input: ProjectRef,
) => Promise<Result<ProjectStatus, OpError>>;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** Ports required by {@link GetService}. */
export type GetServiceDeps = StatusForProjectDeps;

/** Detail of one service (status + config + volumes). `SERVICE_NOT_FOUND` when absent. */
export type GetService = (
	deps: GetServiceDeps,
	input: ServiceRef,
) => Promise<Result<ServiceDetail, OpError>>;

/**
 * Detail of every service of a project, in `locastack.yaml` order (the
 * `GET …/services` list). Same data as {@link GetService} per service.
 */
export type ListServices = (
	deps: GetServiceDeps,
	input: ProjectRef,
) => Promise<Result<ServiceDetail[], OpError>>;

/** Ports required by {@link AddService}. */
export type AddServiceDeps = ResolveDeps & LifecycleDeps;

/** Input of {@link AddService}. */
export interface AddServiceInput extends ServiceRef {
	/** Catalog id. */
	readonly type: string;
	/** Version (default: the definition's `defaultVersion`). */
	readonly version?: string;
	/** Host port or `auto` (default). */
	readonly port?: number | "auto";
	/** Persistence (default `volume`). */
	readonly persist?: PersistMode;
	/** Config overrides. */
	readonly config?: Readonly<Record<string, string>>;
	/**
	 * Initial secret values chosen by the client (Config page "Regenerate"),
	 * by catalog secret name. Keys must be entries of the definition's
	 * `secrets` and values match `SECRET_VALUE_PATTERN` (`INVALID_INPUT`
	 * otherwise). Stored before the first `up`; omitted secrets are generated.
	 * Never echoed in progress events.
	 */
	readonly secrets?: SecretValues;
	/** Seed file relative to the project root (definitions with a `seed` block only). */
	readonly seed?: string;
}

/**
 * Validates the input against the catalog (`INVALID_INPUT` for unknown
 * type/version/config key, `SERVICE_EXISTS` for a taken name), writes the
 * entry to `locastack.yaml` (comments kept), resolves (secrets generated,
 * port pinned; `PORT_CONFLICT` with a `fix` port when an explicit port is
 * busy), renders compose, then `compose up -d --wait <name>` (plus its
 * dependencies). Streams progress.
 */
export type AddService = (
	deps: AddServiceDeps,
	input: AddServiceInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link RemoveService}. */
export type RemoveServiceDeps = ResolveDeps & {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Snapshot index (a removal with volumes deletes the service's snapshots). */
	readonly snapshots: SnapshotIndex;
	/** Deletes snapshot archives and their secret sidecars. */
	readonly archiver: VolumeArchiver;
};

/** Input of {@link RemoveService}. */
export interface RemoveServiceInput extends ServiceRef {
	/** Also delete the service's named volumes (destructive; callers confirm first). */
	readonly volumes?: boolean;
}

/**
 * Stops and removes the service's container (`LifecycleRunner.remove`),
 * deletes its volumes when asked, removes the entry from `locastack.yaml`,
 * unpins its port and re-renders compose. Secrets and snapshots are kept
 * unless volumes are deleted. Refuses (`INVALID_INPUT`) while another service `uses` it.
 */
export type RemoveService = (
	deps: RemoveServiceDeps,
	input: RemoveServiceInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link UpdateService}. */
export type UpdateServiceDeps = ResolveDeps & LifecycleDeps;

/** Input of {@link UpdateService}. */
export interface UpdateServiceInput extends ServiceRef {
	/** Fields to change. */
	readonly patch: ServicePatch;
}

/**
 * Rewrites the entry in `locastack.yaml` (e.g. the "Use port N" fix),
 * re-resolves, re-renders and re-`up`s that service (recreating the
 * container). Switching `persist` to `ephemeral` never deletes volumes.
 */
export type UpdateService = (
	deps: UpdateServiceDeps,
	input: UpdateServiceInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link StartService}. */
export type StartServiceDeps = ResolveDeps & LifecycleDeps;

/**
 * Starts one service: `compose up -d --wait <name>` (creates the container
 * when missing, so it also recovers after a port fix).
 */
export type StartService = (
	deps: StartServiceDeps,
	input: ServiceRef,
) => AsyncIterable<Progress>;

/** Ports required by {@link StopService} and {@link RestartService}. */
export interface ServiceLifecycleDeps extends ProjectReadDeps {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Filesystem layout (rendered compose file). */
	readonly paths: Paths;
}

/** `compose stop <name>`. `SERVICE_NOT_FOUND` (as an `error` event) when absent. */
export type StopService = (
	deps: ServiceLifecycleDeps,
	input: ServiceRef,
) => AsyncIterable<Progress>;

/** `compose restart <name>`. */
export type RestartService = (
	deps: ServiceLifecycleDeps,
	input: ServiceRef,
) => AsyncIterable<Progress>;

// ---------------------------------------------------------------------------
// Environment and connection
// ---------------------------------------------------------------------------

/** Input of {@link EnvPreviewOp}. */
export interface EnvPreviewInput extends ProjectRef {
	/** Output format. */
	readonly format: EnvFormat;
	/** Include secret values (otherwise replaced by `MASKED_SECRET`). */
	readonly reveal: boolean;
}

/**
 * The project's exported variables: each service's evaluated `exports`, the
 * primary one renamed by `link.names`, and every key of a service prefixed
 * with `<INSTANCE_NAME>_` (upper-cased, dashes → `_`) only when one of its
 * keys collides with an earlier service's.
 */
export type EnvPreviewOp = (
	deps: ProjectViewDeps,
	input: EnvPreviewInput,
) => Promise<Result<EnvPreview, OpError>>;

/** Input of {@link LinkEnv}. */
export interface LinkEnvInput extends ProjectRef {
	/** Env file relative to the root (default: `link.file`, else `.env`). */
	readonly file?: string;
}

/**
 * Writes the revealed dotenv variables between the `# locastack:start` /
 * `# locastack:end` markers of the env file (rest of the file untouched).
 * `INVALID_INPUT` when `file` escapes the project root.
 */
export type LinkEnv = (
	deps: ProjectViewDeps,
	input: LinkEnvInput,
) => Promise<Result<LinkEnvResult, OpError>>;

/** Input of {@link GetConnection}. */
export interface GetConnectionInput extends ServiceRef {
	/** Include secret values (otherwise replaced by `MASKED_SECRET`). */
	readonly reveal: boolean;
}

/**
 * Connect-tab data for one service: primary export (definition
 * `primaryExport`, final name as in {@link EnvPreviewOp}), all exports,
 * details grid, and snippets (catalog `snippets` with `KEY` replaced).
 */
export type GetConnection = (
	deps: ProjectViewDeps,
	input: GetConnectionInput,
) => Promise<Result<ConnectionInfo, OpError>>;

// ---------------------------------------------------------------------------
// CLI (cwd-based) stack ops
// ---------------------------------------------------------------------------

/** Ports required by {@link UpStack}. */
export type UpStackDeps = ResolveDeps & LifecycleDeps;

/** Input of {@link UpStack}. */
export interface UpStackInput {
	/** Stack to start. */
	readonly stack: Stack;
	/** Limit to these instance names (all when omitted). */
	readonly services?: readonly string[];
}

/**
 * Checks the compose version, claims the project name for its folder, then
 * resolves, renders and `compose up --wait`s the stack, streaming progress.
 * Ends with exactly one `done` or `error` event.
 */
export type UpStack = (
	deps: UpStackDeps,
	input: UpStackInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link DownStack}. */
export interface DownStackDeps {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Persisted state (project registry: which folder owns the name). */
	readonly state: StateReader;
	/** File access (detects a stale project registration). */
	readonly files: FileStore;
}

/** Input of {@link DownStack}. */
export interface DownStackInput {
	/** Stack to stop. */
	readonly stack: Stack;
	/** Also remove named volumes (destructive; callers confirm first). */
	readonly volumes?: boolean;
}

/**
 * Stops a stack's compose project, streaming progress. Refuses (one `error`
 * event) a stack whose name belongs to another project folder.
 */
export type DownStack = (
	deps: DownStackDeps,
	input: DownStackInput,
) => AsyncIterable<Progress>;

/** Ports required by {@link EnvForStack}. */
export interface EnvForStackDeps {
	/** File access. */
	readonly files: FileStore;
	/** Persisted state (pinned ports). */
	readonly state: StateReader;
	/** Secret persistence. */
	readonly secrets: SecretStore;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
}

/** Input of {@link EnvForStack}. */
export interface EnvForStackInput {
	/** Stack whose exports to print. */
	readonly stack: Stack;
	/** Output format. */
	readonly format: EnvFormat;
}

/**
 * Renders a stack's exported variables (revealed) in the requested format.
 * Refuses a stack whose name belongs to another project folder.
 */
export type EnvForStack = (
	deps: EnvForStackDeps,
	input: EnvForStackInput,
) => Promise<Result<string, OpError>>;

/** Ports required by {@link DiscoverStack}. */
export interface DiscoverStackDeps {
	/** File access. */
	readonly files: FileStore;
}

/** Input of {@link DiscoverStack}. */
export interface DiscoverStackInput {
	/** Directory to start the walk-up from. */
	readonly cwd: string;
}

/**
 * Finds and validates the project stack for `cwd` (walk-up to
 * `locastack.yaml`). `STACK_NOT_FOUND` when none is found.
 */
export type DiscoverStack = (
	deps: DiscoverStackDeps,
	input: DiscoverStackInput,
) => Promise<Result<Stack, OpError>>;

// ---------------------------------------------------------------------------
// Data tab (query runner)
// ---------------------------------------------------------------------------

/**
 * Ports required by {@link ListDataObjects} and {@link RunQuery}: the project
 * view (stack, catalog, stored secrets and pins to render the catalog's
 * `data` templates), inspect (the container must be running) and exec.
 */
export interface DataDeps extends ProjectViewDeps {
	/** Container inspect (running check, container id). */
	readonly inspector: ContainerInspector;
	/** `docker exec`. */
	readonly exec: ContainerExec;
}

/**
 * Object list of the Data tab: runs the catalog's `data.listObjects` argv in
 * the running container (one object per stdout line, blank lines dropped,
 * at most `DATA_MAX_OBJECTS`), or returns the static `data.objects`, each
 * with its `defaultQuery`. Limits: `DATA_QUERY_TIMEOUT_MS`,
 * `DATA_QUERY_MAX_BYTES`.
 *
 * Errors: `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`; `INVALID_INPUT` when the
 * definition has no `data` block or `data.kind` is `none` (details.fix);
 * `SERVICE_NOT_RUNNING` ("<name> is not running. Start it to run queries.")
 * when there is no running container; `INVALID_INPUT` with a secret-free
 * stderr excerpt when the command exits non-zero or times out.
 */
export type ListDataObjects = (
	deps: DataDeps,
	input: ServiceRef,
) => Promise<Result<DataObjects, OpError>>;

/** Input of {@link RunQuery}. */
export interface RunQueryInput extends ServiceRef {
	/** Query text; blank (whitespace only) is `INVALID_INPUT` ("Query is empty."). */
	readonly query: string;
	/** Most rows to return, 1..`DATA_QUERY_MAX_ROWS` (default the maximum). */
	readonly limit?: number;
}

/**
 * Runs a read or write query with the catalog's `data.runQuery` argv in the
 * running container (no shell) and parses its CSV stdout. Hard limits:
 * `DATA_QUERY_TIMEOUT_MS` (15 s), `DATA_QUERY_MAX_BYTES` (2 MB of output),
 * `limit` ≤ `DATA_QUERY_MAX_ROWS` (1000) rows; exceeding the byte or row cap
 * sets `truncated`.
 *
 * Errors: as {@link ListDataObjects}; a query the engine rejects (non-zero
 * exit, e.g. `ERROR: relation "x" does not exist`) or a timeout is
 * `INVALID_INPUT` whose message is the tool's first error line(s) with any
 * secret value masked, `details.exitCode` / `details.timedOut` set.
 */
export type RunQuery = (
	deps: DataDeps,
	input: RunQueryInput,
) => Promise<Result<DataQueryResult, OpError>>;

// ---------------------------------------------------------------------------
// Snapshots and seeding
// ---------------------------------------------------------------------------

/** Ports required by {@link ListSnapshots}. */
export interface ListSnapshotsDeps extends ProjectReadDeps {
	/** Snapshot index. */
	readonly snapshots: SnapshotIndex;
}

/** The service's snapshots, newest first. `SERVICE_NOT_FOUND` when absent. */
export type ListSnapshots = (
	deps: ListSnapshotsDeps,
	input: ServiceRef,
) => Promise<Result<Snapshot[], OpError>>;

/**
 * Ports required by {@link CreateSnapshot} and {@link RestoreSnapshot}:
 * compose lifecycle (stop/start the service), catalog (volume names), the
 * archiver, the index, paths (archive location), clock (`createdAt`) and a
 * generator for ids.
 */
export interface SnapshotDeps extends ProjectReadDeps, LifecycleDeps {
	/** Stored secrets (the values baked into the volume go to the sidecar). */
	readonly secrets: SecretStore;
	/** Filesystem layout (`<stateDir>/snapshots`, rendered compose file). */
	readonly paths: Paths;
	/** Merged catalog (the definition's `volumes`). */
	readonly catalog: CatalogSource;
	/** Volume tar/untar with a helper container. */
	readonly archiver: VolumeArchiver;
	/** Snapshot index. */
	readonly snapshots: SnapshotIndex;
	/** Time source (`createdAt`). */
	readonly clock: Clock;
	/** Id source: `gen.generate(9)` gives a 12-character base64url id. */
	readonly gen: SecretGenerator;
}

/** Input of {@link CreateSnapshot}. */
export interface CreateSnapshotInput extends ServiceRef {
	/**
	 * Display name (`SNAPSHOT_NAME_PATTERN`; default `snap-<n>`). The HTTP
	 * body calls it `name`; `name` here is the service instance.
	 */
	readonly snapshotName?: string;
}

/**
 * Archives the service's named volume(s) to
 * `<stateDir>/snapshots/<project>/<service>/<id>.tgz` and inserts an index
 * row. Steps, each reported as a `step` event: "Stopping <name>" (only when
 * it was running: a tar of a live database volume is inconsistent),
 * "Archiving <volume>", "Starting <name>" (only when it was running before;
 * also attempted after a failed archive), then `done` ("Snapshot “<name>”
 * created"). `INVALID_INPUT` (as an `error` event) when the service's
 * `persist` is `ephemeral` or the definition has no volumes. A definition
 * with several volumes is archived into one tar with one top-level folder
 * per catalog volume name.
 */
export type CreateSnapshot = (
	deps: SnapshotDeps,
	input: CreateSnapshotInput,
) => AsyncIterable<Progress>;

/** Input of {@link RestoreSnapshot} and {@link DeleteSnapshot}. */
export interface SnapshotRef extends ServiceRef {
	/** Snapshot id. */
	readonly snapshotId: string;
}

/**
 * Ports required by {@link RestoreSnapshot}: those of {@link CreateSnapshot}
 * plus the resolve ports, to put a snapshot's baked-in secrets back and
 * re-render the compose `.env`.
 */
export type RestoreSnapshotDeps = SnapshotDeps & ResolveDeps;

/**
 * Replaces the volume contents with a snapshot: "Stopping <name>",
 * "Restoring “<snapshot>”" (untar into a staging folder, then swap),
 * "Restoring <KEY…> saved with the snapshot" (only when the secrets baked
 * into the archived volume differ from the stored ones: they are stored
 * again and compose re-rendered, so `.env` matches the restored data),
 * "Starting <name>" (always started afterwards; with its dependents when
 * secrets changed), then `done`. `SNAPSHOT_NOT_FOUND` when the id is
 * unknown, belongs to another service, or its file is gone; `INVALID_INPUT`
 * when the snapshot was taken from another catalog type or major version.
 */
export type RestoreSnapshot = (
	deps: RestoreSnapshotDeps,
	input: SnapshotRef,
) => AsyncIterable<Progress>;

/** Ports required by {@link DeleteSnapshot}. */
export interface DeleteSnapshotDeps extends ListSnapshotsDeps {
	/** Removes the archive file. */
	readonly archiver: VolumeArchiver;
}

/**
 * Deletes the archive file and its index row (containers are untouched, so
 * this is a plain `Result` op). `SNAPSHOT_NOT_FOUND` when unknown or owned by
 * another service.
 */
export type DeleteSnapshot = (
	deps: DeleteSnapshotDeps,
	input: SnapshotRef,
) => Promise<Result<Snapshot, OpError>>;

/** Ports required by {@link SeedService}. */
export interface SeedServiceDeps extends ProjectViewDeps {
	/** Container inspect (running check). */
	readonly inspector: ContainerInspector;
	/** `docker exec` (the seed is piped to stdin). */
	readonly exec: ContainerExec;
}

/**
 * Re-applies the entry's seed file: reads `<root>/<seed>` and pipes it to the
 * catalog's `seed.run` argv in the running container (timeout
 * `SEED_TIMEOUT_MS`). Steps: "Seeding <name> from ./<seed>", then `done`
 * ("Seeded <name> from ./<seed>"). Errors (as `error` events):
 * `INVALID_INPUT` when the definition has no `seed` block or the entry has no
 * `seed` (details.fix: set one on the Config page), `IO` when the file is
 * missing, `SERVICE_NOT_RUNNING`, `INVALID_INPUT` with a secret-free stderr
 * excerpt when the command fails.
 */
export type SeedService = (
	deps: SeedServiceDeps,
	input: ServiceRef,
) => AsyncIterable<Progress>;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Ports required by {@link RotateSecret}. */
export type RotateSecretDeps = ResolveDeps & LifecycleDeps;

/** Input of {@link RotateSecret}. */
export interface RotateSecretInput extends ServiceRef, RotateSecretOptions {
	/** Catalog secret name, e.g. `POSTGRES_PASSWORD` (an entry of the definition's `secrets`). */
	readonly key: string;
}

/**
 * Generates a new value for one secret of a service, stores it (secrets file
 * and compose `.env`), and recreates the container (`up --wait`, also
 * recreating dependents that interpolate it, e.g. upstash-redis on redis).
 *
 * Refuses with `INVALID_INPUT` (as an `error` event, and as a `422` pre-check
 * in the server) when the catalog marks the secret `bakedIntoVolume` and the
 * service has a data volume (`persist: volume`), unless `force` and
 * `wipeVolume` are both true; `details.fix` explains that the value is
 * written into the volume on first init and that rotating needs a wipe
 * (or a snapshot first). With `wipeVolume` the steps are "Removing <name>",
 * "Deleting volume <vol>", "Rotating <KEY>", "Starting <name>". Secrets not
 * marked (redis, upstash) rotate freely. `INVALID_INPUT` for an unknown key.
 * Progress never carries the value.
 */
export type RotateSecret = (
	deps: RotateSecretDeps,
	input: RotateSecretInput,
) => AsyncIterable<Progress>;

// ---------------------------------------------------------------------------
// Import docker-compose.yml
// ---------------------------------------------------------------------------

/**
 * Parses compose YAML (with the `yaml` package, never regexes) into the
 * fields Import needs. `INVALID_INPUT` for text over `IMPORT_YAML_MAX_BYTES`,
 * invalid YAML (message with line:col), no top-level `services` map ("No
 * services found. Make sure the file has a top-level “services:” key."), or
 * more than `IMPORT_MAX_SERVICES` services. Pure.
 */
export type ParseComposeForImport = (
	yamlText: string,
) => Result<ParsedCompose, OpError>;

/** Input of {@link MapComposeToCatalog}. */
export interface MapComposeInput {
	/** Parsed compose services. */
	readonly parsed: ParsedCompose;
	/** Merged catalog definitions (their `import` blocks drive matching). */
	readonly definitions: readonly ServiceDefinition[];
	/**
	 * Host ports already pinned by registered projects: port → owner label
	 * (`<project>/<service>`), e.g. from `portsReservedByOtherStacks`.
	 */
	readonly reserved: ReadonlyMap<number, string>;
	/** Probes wanted ports on 127.0.0.1 (5432/6379/8079 held by another local stack). */
	readonly probe: PortProbe;
}

/**
 * Maps parsed compose services onto catalog definitions:
 *
 * - type: the first definition whose `import.images` contains the image
 *   repository (built-ins: postgres, postgis/postgis, pgvector/pgvector →
 *   postgres; redis, valkey/valkey → redis; hiett/serverless-redis-http,
 *   upstash/redis-http → upstash-redis). Build-only services and unmatched
 *   images are `supported: false`, `include: false` with a `skipReason`.
 * - version: the tag's leading version when it is one of `versions`.
 * - config / secrets: compose `environment` keys named like a config key or
 *   secret (plus `import.env` renames); secret values outside
 *   `IMPORT_SECRET_VALUE_PATTERN` are dropped.
 * - ports: `wantedPort` = the published host port mapped to the definition's
 *   container port (else the first published port, else `port.default`);
 *   when it is reserved, busy on 127.0.0.1 or claimed by an earlier item, the
 *   next free port in the definition's range becomes `hostPort` with a
 *   `remapNote` ("5432 is used by shop-api/main-db", "5432 is in use on this
 *   machine", "5432 is used by another service in this file").
 * - name: the compose key lower-cased with other characters → `-`, made
 *   unique and prefixed when it does not start with a letter.
 */
export type MapComposeToCatalog = (
	input: MapComposeInput,
) => Promise<ImportPlan>;

/** Ports required by {@link PreviewImport}. */
export interface PreviewImportDeps {
	/** Registered projects (taken names) and every project's pinned ports. */
	readonly state: StateReader;
	/** Merged catalog. */
	readonly catalog: CatalogSource;
	/** Host port probe. */
	readonly probe: PortProbe;
}

/** Input of {@link PreviewImport}. */
export interface PreviewImportInput {
	/** Compose file text (pasted or dropped in the dashboard). */
	readonly yaml: string;
	/** Preferred project name (e.g. from the file name); used when valid and free. */
	readonly projectName?: string;
}

/**
 * {@link ParseComposeForImport} then {@link MapComposeToCatalog}, plus a
 * free, valid `suggestedName` (`projectName`, else `compose-app`,
 * `compose-app-2`, …). Mutates nothing.
 */
export type PreviewImport = (
	deps: PreviewImportDeps,
	input: PreviewImportInput,
) => Promise<Result<ImportPreview, OpError>>;

/** Ports required by {@link ImportProject}. */
export type ImportProjectDeps = ResolveDeps & LifecycleDeps;

/** Input of {@link ImportProject}. */
export interface ImportProjectInput {
	/** New project name (`^[a-z][a-z0-9-]*$`, not registered). */
	readonly name: string;
	/** Absolute project folder; created when missing. Must not already hold `locastack.yaml`. */
	readonly root: string;
	/** Preview items; only `supported && include` ones are imported (at least one). */
	readonly items: readonly ImportItem[];
	/** `up --wait` the imported services afterwards. */
	readonly start: boolean;
}

/**
 * Re-validates the items against the catalog (type, version, config keys,
 * instance names unique), then: "Creating <root>" (mkdir when missing),
 * "Writing locastack.yaml" (one entry per included item: type, version,
 * `port: hostPort` or auto, `persist: volume`, config), "Storing secrets"
 * (supplied values; the rest are generated on resolve), "Registering <name>",
 * optionally "Starting N services" (`upStack`), then `done` ("Imported N
 * services into <name>[, M ports remapped]"). `PROJECT_EXISTS` when the name
 * is registered or `<root>/locastack.yaml` exists; `PORT_CONFLICT` when a
 * `hostPort` became busy since the preview; `INVALID_INPUT` otherwise. A
 * failure before registration leaves no `locastack.yaml` behind.
 */
export type ImportProject = (
	deps: ImportProjectDeps,
	input: ImportProjectInput,
) => AsyncIterable<Progress>;
