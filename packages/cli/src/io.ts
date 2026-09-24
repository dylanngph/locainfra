import { confirm, isCancel, select } from "@clack/prompts";
import type { CliIo, ExitCode, SelectChoice } from "./cli.types";

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
			async select<T extends string>(
				message: string,
				choices: readonly SelectChoice<T>[],
				initialValue: T,
			): Promise<T | undefined> {
				// clack's Option<T> is a conditional type a generic T cannot satisfy,
				// so the prompt works on strings and the answer is mapped back.
				const answer = await select<string>({
					message,
					options: choices.map((choice) => ({
						value: choice.value,
						label: choice.label,
						...(choice.hint === undefined ? {} : { hint: choice.hint }),
					})),
					initialValue,
				});
				if (isCancel(answer)) return undefined;
				return choices.find((choice) => choice.value === answer)?.value;
			},
		},
		cwd: () => process.cwd(),
		setExitCode: (code: ExitCode) => {
			process.exitCode = code;
		},
	};
}
