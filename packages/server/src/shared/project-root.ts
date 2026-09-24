import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type FileStore, OpError, type Paths } from "@locastack/core";

/** Ports {@link checkProjectRoot} reads. */
export interface ProjectRootPorts {
	/** File access (existence, directory checks). */
	readonly files: FileStore;
	/** Filesystem layout (`home`). */
	readonly paths: Paths;
}

/**
 * Expands `~`, normalizes, and applies the project folder rules shared by
 * New project and Import: the folder must be an existing directory, or a
 * missing leaf whose parent is an existing directory; the home folder, its
 * ancestors and hidden folders (any `.name` segment) are refused. Reads only.
 *
 * @param input - Folder as typed or picked (`~` allowed).
 * @param ports - Files and paths.
 * @returns The absolute, normalized folder.
 * @throws OpError `INVALID_INPUT` with `details.fix`.
 */
export async function checkProjectRoot(
	input: string,
	ports: ProjectRootPorts,
): Promise<string> {
	const expanded = expandHome(input.trim(), ports.paths.home);
	if (!isAbsolute(expanded))
		throw invalidRoot("The folder must be an absolute path");
	const root = resolve(expanded);
	const home = resolve(ports.paths.home);
	if (root === home || home.startsWith(root === sep ? sep : `${root}${sep}`))
		throw invalidRoot(
			"Choose a project folder inside your home folder, not the home folder itself",
		);
	if (root.split(sep).some((segment) => segment.startsWith(".")))
		throw invalidRoot(
			"Hidden folders (starting with a dot) cannot hold a project",
		);
	const files = ports.files;
	if (await files.exists(root)) {
		if (!(await files.isDirectory(root)))
			throw invalidRoot(`${root} is a file, not a folder`);
		return root;
	}
	const parent = dirname(root);
	if (!(await files.isDirectory(parent)))
		throw invalidRoot(`${parent} does not exist`, {
			fix: "Create the parent folder first, or pick an existing folder",
		});
	return root;
}

function expandHome(root: string, home: string): string {
	if (root === "~") return home;
	if (root.startsWith("~/")) return join(home, root.slice(2));
	return root;
}

function invalidRoot(
	message: string,
	details: Readonly<Record<string, string>> = {
		fix: "Choose a folder such as ~/Developer/<name>",
	},
): OpError {
	return new OpError("INVALID_INPUT", message, { details });
}
