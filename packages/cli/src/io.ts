import { confirm } from "@clack/prompts";
import type { CliIo, ExitCode } from "./cli.types";

/**
 * The real process boundary: `process.stdout/stderr`, clack prompts, and
 * `process.exitCode`. Interactive only when both stdin and stdout are TTYs and
 * `CI` is not set.
 *
 * @returns A {@link CliIo} bound to the current process.
 */
export function createProcessIo(): CliIo {
	const isTTY = Boolean(
		process.stdout.isTTY && process.stdin.isTTY && !process.env.CI,
	);
	return {
		stdout: process.stdout,
		stderr: process.stderr,
		isTTY,
		prompter: {
			async confirm(message: string): Promise<boolean> {
				const answer = await confirm({ message, initialValue: false });
				return answer === true;
			},
		},
		cwd: () => process.cwd(),
		setExitCode: (code: ExitCode) => {
			process.exitCode = code;
		},
	};
}
