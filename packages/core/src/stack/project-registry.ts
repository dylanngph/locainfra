import { join, resolve } from "node:path";
import type { FileStore } from "../ports/files.port";
import type { StateFile, StateReader, StateWriter } from "../ports/state.port";
import { OpError } from "../shared/op-error";
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
	return state.projects.find((project) => project.name === name)?.root;
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
		kind: "project",
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
	return new OpError("IO", "Could not read the LocaInfra project registry", {
		cause,
		details: { stack: stack.name },
	});
}

/**
 * Read-only ownership check for ops that act on an existing stack (`env`,
 * `down`): a project stack whose name is registered to a different, still
 * valid project folder is refused. The global stack and unregistered names
 * pass.
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
	if (stack.kind !== "project" || stack.root === undefined) {
		return ok(undefined);
	}
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
 * `up`), so two folders declaring the same `name:` cannot share one compose
 * project, its volumes, secrets and ports. A claim whose folder no longer
 * declares that name (moved, deleted or renamed project) is taken over. The
 * check and the write happen in one `state.update`, so concurrent claims from
 * two folders cannot both succeed.
 *
 * @param deps - State and file access.
 * @param stack - The stack being started.
 * @returns `ok`, `INVALID_STACK` (name owned by another folder, with a fix
 *   hint) or `IO`.
 */
export async function claimProjectName(
	deps: ProjectClaimDeps,
	stack: Stack,
): Promise<Result<void>> {
	if (stack.kind !== "project" || stack.root === undefined) {
		return ok(undefined);
	}
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
