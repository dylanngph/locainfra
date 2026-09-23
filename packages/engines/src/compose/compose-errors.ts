import { OpError } from "@locainfra/core";

const PORT_PATTERNS: readonly RegExp[] = [
	/port is already allocated/i,
	/address already in use/i,
	/ports are not available/i,
];

/**
 * Extracts the conflicting host port from compose/Docker error text such as
 * `Bind for 127.0.0.1:5432 failed: port is already allocated` or
 * `listen tcp4 127.0.0.1:6379: bind: address already in use`.
 *
 * @param text - Error output.
 * @returns The port, or `undefined` when none is found.
 */
export function extractConflictPort(text: string): number | undefined {
	const match =
		/Bind for [^\s]*:(\d{1,5}) failed/i.exec(text) ??
		/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|localhost):(\d{1,5})/.exec(text);
	const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Classifies a failed `docker compose` invocation into a typed {@link OpError}.
 *
 * @param output - Captured output lines (stderr and stdout).
 * @param exitCode - Process exit code.
 * @param action - Compose subcommand, for the message (e.g. `up`).
 * @returns `PORT_CONFLICT`, `DOCKER_UNREACHABLE`, `COMPOSE_MISSING` or `UNKNOWN`.
 */
export function classifyComposeFailure(
	output: readonly string[],
	exitCode: number,
	action: string,
): OpError {
	const text = output.join("\n");
	if (PORT_PATTERNS.some((p) => p.test(text))) {
		const port = extractConflictPort(text);
		return new OpError(
			"PORT_CONFLICT",
			port === undefined
				? "A host port is already in use"
				: `Host port ${port} is already in use`,
			{ details: port === undefined ? { exitCode } : { port, exitCode } },
		);
	}
	if (
		/Cannot connect to the Docker daemon/i.test(text) ||
		/docker daemon is not running/i.test(text) ||
		/error during connect/i.test(text)
	) {
		return new OpError(
			"DOCKER_UNREACHABLE",
			"The Docker daemon is not running",
			{
				details: { exitCode },
			},
		);
	}
	if (
		/'compose' is not a docker command/i.test(text) ||
		/unknown (?:shorthand )?(?:flag|command).*compose/i.test(text)
	) {
		return new OpError(
			"COMPOSE_MISSING",
			"The docker compose plugin is not installed",
			{
				details: { exitCode },
			},
		);
	}
	const lastLine = [...output].reverse().find((line) => line.trim() !== "");
	return new OpError(
		"UNKNOWN",
		`docker compose ${action} failed (exit ${exitCode})${lastLine ? `: ${lastLine.trim()}` : ""}`,
		{ details: { exitCode } },
	);
}
