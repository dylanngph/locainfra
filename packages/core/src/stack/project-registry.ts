import { join, resolve } from "node:path";
import { serviceContainerName } from "../paths/layout";
import type { FileStore } from "../ports/files.port";
import type {
	ProjectEntry,
	StateFile,
	StateReader,
	StateWriter,
} from "../ports/state.port";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import { loadStack } from "./loader";
import { PROJECT_STACK_FILE_NAME, type Stack } from "./stack.model";

/** Ports needed by {@link checkProjectOwner}. */
export interface ProjectOwnerCheckDeps {
	/** Persisted state (`projects` registry). */
	readonly state: StateReader;
	/** Reads the registered project's stack file to detect a stale claim. */
	readonly files: FileStore;
}

/** Ports needed by {@link claimProjectName}. */
export interface ProjectClaimDeps extends ProjectOwnerCheckDeps {
	/** Persisted state (`projects` registry is written here). */
	readonly state: StateReader & StateWriter;
}

/**
 * @param state - Persisted state.
 * @param name - Stack name.
 * @returns The project root registered for `name`, if any.
 */
export function registeredProjectRoot(
	state: StateFile,
	name: string,
): string | undefined {
	return findProjectEntry(state, name)?.root;
}

/**
 * @param state - Persisted state.
 * @param name - Project name.
 * @returns The registry entry of `name`, if any.
 */
export function findProjectEntry(
	state: StateFile,
	name: string,
): ProjectEntry | undefined {
	return state.projects.find((project) => project.name === name);
}

/** Two projects whose Docker container names would be equal. */
export interface ContainerNameClash {
	/** The shared container name, e.g. `li-shop-api-db`. */
	readonly containerName: string;
	/** Service instance of the project being checked. */
	readonly service: string;
	/** The other registered project. */
	readonly otherProject: string;
	/** Its folder. */
	readonly otherRoot: string;
	/** Its service instance with the same container name. */
	readonly otherService: string;
}

/** A project (or a would-be project) whose container names are checked. */
export interface ContainerNameCandidate {
	/** Project name. */
	readonly name: string;
	/** Project folder (its own registration is skipped). */
	readonly root: string;
	/** Service instance names to check. */
	readonly services: readonly string[];
}

/**
 * Finds a container name the candidate would share with another registered
 * project: containers are named `li-<project>-<service>`, so `shop` + `api-db`
 * and `shop-api` + `db` both give `li-shop-api-db`. Projects whose file is
 * missing or invalid are skipped.
 *
 * @param deps - State and file access.
 * @param candidate - Project name, folder and service names.
 * @returns The first clash, or `undefined`.
 * @throws When state cannot be read.
 */
export async function findContainerNameClash(
	deps: ProjectOwnerCheckDeps,
	candidate: ContainerNameCandidate,
): Promise<ContainerNameClash | undefined> {
	const own = new Map(
		candidate.services.map((service) => [
			serviceContainerName(candidate.name, service),
			service,
		]),
	);
	if (own.size === 0) return undefined;
	const root = resolve(candidate.root);
	const state = await deps.state.read();
	for (const project of state.projects) {
		if (project.name === candidate.name || resolve(project.root) === root) {
			continue;
		}
		const loaded = await loadStack(deps.files, {
			filePath: join(project.root, PROJECT_STACK_FILE_NAME),
			root: project.root,
		});
		if (!loaded.ok) continue;
		for (const otherService of Object.keys(loaded.value.file.services)) {
			const containerName = serviceContainerName(project.name, otherService);
			const service = own.get(containerName);
			if (service !== undefined) {
				return {
					containerName,
					service,
					otherProject: project.name,
					otherRoot: project.root,
					otherService,
				};
			}
		}
	}
	return undefined;
}

/**
 * @param clash - The clash found by {@link findContainerNameClash}.
 * @param code - Error code to use (`PROJECT_EXISTS` for registration, `SERVICE_EXISTS` for a new service).
 * @returns A secret-free error with a fix hint.
 */
export function containerNameClashError(
	clash: ContainerNameClash,
	code: "INVALID_STACK" | "PROJECT_EXISTS" | "SERVICE_EXISTS",
): OpError {
	return new OpError(
		code,
		`Container name ${clash.containerName} is already used by service "${clash.otherService}" of project "${clash.otherProject}"`,
		{
			details: {
				reason: "container-name",
				containerName: clash.containerName,
				service: clash.service,
				otherProject: clash.otherProject,
				otherRoot: clash.otherRoot,
				fix: `Rename the service "${clash.service}" (or the project) so li-<project>-<service> differs from ${clash.containerName}.`,
			},
		},
	);
}

/**
 * Whether a registration of `name` at `root` no longer holds: the folder has
 * no `locainfra.yaml` any more, or its file now names another stack. An
 * unreadable or invalid file keeps the claim (fail safe).
 */
async function isStaleClaim(
	files: FileStore,
	root: string,
	name: string,
): Promise<boolean> {
	const loaded = await loadStack(files, {
		filePath: join(root, PROJECT_STACK_FILE_NAME),
		root,
	});
	if (loaded.ok) return loaded.value.name !== name;
	return loaded.error.code === "STACK_NOT_FOUND";
}

function nameTaken(stack: Stack, owner: string): OpError {
	return new OpError(
		"INVALID_STACK",
		`Stack name "${stack.name}" is already used by the project at ${owner}`,
		{
			details: {
				reason: "name-taken",
				stack: stack.name,
				root: stack.root,
				registeredRoot: owner,
				filePath: stack.filePath,
				fix: `Rename "name:" in ${stack.filePath} to a name no other project uses. Stack names are shared by all projects: they key the compose project li-<name>, its volumes, secrets and pinned ports.`,
			},
		},
	);
}

function ioError(stack: Stack, cause: unknown): OpError {
	return ioErrorFrom("Could not read the LocaInfra project registry", cause, {
		stack: stack.name,
	});
}

/**
 * Read-only ownership check for ops that act on an existing stack (`env`,
 * `down`): a project stack whose name is registered to a different, still
 * valid project folder is refused. Unregistered names pass.
 *
 * @param deps - State and file access.
 * @param stack - The stack about to be used.
 * @returns `ok`, `INVALID_STACK` (name owned by another folder, with a fix
 *   hint) or `IO`.
 */
export async function checkProjectOwner(
	deps: ProjectOwnerCheckDeps,
	stack: Stack,
): Promise<Result<void>> {
	const root = resolve(stack.root);
	try {
		const owner = registeredProjectRoot(await deps.state.read(), stack.name);
		if (owner === undefined || owner === root) return ok(undefined);
		if (await isStaleClaim(deps.files, owner, stack.name)) return ok(undefined);
		return err(nameTaken(stack, owner));
	} catch (cause) {
		return err(ioError(stack, cause));
	}
}

/**
 * Binds a project stack's name to its folder in `state.projects` (first
 * `up`, registration), so two folders declaring the same `name:` cannot share
 * one compose project, its volumes, secrets and ports. A claim whose folder
 * no longer declares that name (moved, deleted or renamed project) is taken
 * over. A new claim is also refused when one of its container names equals
 * another project's ({@link findContainerNameClash}). The check and the write
 * happen in one `state.update`, so concurrent claims from two folders cannot
 * both succeed.
 *
 * @param deps - State and file access.
 * @param stack - The stack being started or registered.
 * @returns `ok`, `INVALID_STACK` (name owned by another folder, or a
 *   container name clash; `details.reason` is `name-taken` or
 *   `container-name`, with a fix hint) or `IO`.
 */
export async function claimProjectName(
	deps: ProjectClaimDeps,
	stack: Stack,
): Promise<Result<void>> {
	const root = resolve(stack.root);
	try {
		const owner = registeredProjectRoot(await deps.state.read(), stack.name);
		if (owner === root) return ok(undefined);
		let staleOwner: string | undefined;
		if (owner !== undefined) {
			if (!(await isStaleClaim(deps.files, owner, stack.name))) {
				return err(nameTaken(stack, owner));
			}
			staleOwner = owner;
		}
		const clash = await findContainerNameClash(deps, {
			name: stack.name,
			root,
			services: Object.keys(stack.file.services),
		});
		if (clash !== undefined) {
			return err(containerNameClashError(clash, "INVALID_STACK"));
		}
		let conflict: string | undefined;
		await deps.state.update((state) => {
			const current = registeredProjectRoot(state, stack.name);
			if (current === root) return state;
			if (current !== undefined && current !== staleOwner) {
				conflict = current;
				return state;
			}
			return {
				...state,
				projects: [
					// One folder holds one stack: drop its old name and the stale claim.
					...state.projects.filter(
						(project) => project.name !== stack.name && project.root !== root,
					),
					{ name: stack.name, root },
				],
			};
		});
		return conflict === undefined
			? ok(undefined)
			: err(nameTaken(stack, conflict));
	} catch (cause) {
		return err(ioError(stack, cause));
	}
}
