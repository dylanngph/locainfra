import { execFileSync } from "node:child_process";

/**
 * Runs `docker` and returns trimmed stdout lines.
 *
 * @param args - Docker CLI arguments.
 * @returns Non-empty output lines.
 */
export function docker(args: readonly string[]): string[] {
	return execFileSync("docker", [...args], { encoding: "utf8" })
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/**
 * Everything Docker still holds for a LocaStack project: containers,
 * volumes and networks named `ls-<project>…`.
 *
 * @param project - Project name.
 * @returns Leftover resource names.
 */
export function leftovers(project: string): string[] {
	const prefix = `ls-${project}`;
	return [
		...docker(["ps", "-a", "--format", "{{.Names}}"]),
		...docker(["volume", "ls", "--format", "{{.Name}}"]),
		...docker(["network", "ls", "--format", "{{.Name}}"]),
	].filter((name) => name === prefix || name.startsWith(`${prefix}-`));
}

/**
 * Last-resort cleanup of a project's containers, volumes and network (only
 * resources labelled/named for this project; never anything else).
 *
 * @param project - Project name.
 */
export function forceCleanup(project: string): void {
	const label = `label=locastack.stack=${project}`;
	const containers = docker(["ps", "-aq", "--filter", label]);
	if (containers.length) docker(["rm", "-f", ...containers]);
	const volumes = docker(["volume", "ls", "-q", "--filter", label]);
	if (volumes.length) docker(["volume", "rm", "-f", ...volumes]);
	const network = `ls-${project}`;
	if (docker(["network", "ls", "--format", "{{.Name}}"]).includes(network))
		docker(["network", "rm", network]);
}

/**
 * Snapshot helper containers (`docker run --rm`, label `io.locastack.helper`)
 * still present; there should never be any once an op settled.
 *
 * @returns Helper container names.
 */
export function helperContainers(): string[] {
	return docker([
		"ps",
		"-a",
		"--filter",
		"label=io.locastack.helper",
		"--format",
		"{{.Names}}",
	]);
}
