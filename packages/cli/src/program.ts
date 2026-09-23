import { CommanderError } from "@commander-js/extra-typings";
import {
	type CliDepsLoader,
	type CliIo,
	type CommandContext,
	ExitCode,
} from "./cli.types";
import { runDashboard } from "./commands/dashboard/dashboard.command";
import { registerDoctorCommand } from "./commands/doctor/doctor.command";
import { registerDownCommand } from "./commands/down/down.command";
import { registerEnvCommand } from "./commands/env/env.command";
import { registerUpCommand } from "./commands/up/up.command";
import { createProcessIo } from "./io";
import { createRootCommand, type RootCommand } from "./root";
import { writeLine } from "./ui/output";
import { theme } from "./ui/theme";

/**
 * Builds the full `locainfra` program. Deps are loaded lazily by each action,
 * so `--help`/`--version` stay instant and tests inject fakes via `loadDeps`.
 *
 * @param loadDeps - Composition root (real: `composeDeps` from `composition.ts`).
 * @param io - Process boundary (defaults to the real process).
 * @returns The configured root command; call `parseAsync(args, { from: "user" })`.
 */
export function createProgram(
	loadDeps: CliDepsLoader,
	io: CliIo = createProcessIo(),
): RootCommand {
	const ctx: CommandContext = { io, loadDeps };
	const program = createRootCommand(io);
	registerUpCommand(program, ctx);
	registerDownCommand(program, ctx);
	registerEnvCommand(program, ctx);
	registerDoctorCommand(program, ctx);
	program.action(async (opts) => {
		io.setExitCode(
			await runDashboard(ctx, {
				json: opts.json === true,
				open: opts.open,
				...(opts.port === undefined ? {} : { port: opts.port }),
				...(opts.project === undefined ? {} : { project: opts.project }),
			}),
		);
	});
	return program;
}

/**
 * Parses `args`, runs the matching command and maps every outcome to an exit
 * code: 0 ok (including `--help`/`--version`), 1 op error or unexpected
 * failure, 2 usage error.
 *
 * @param args - User arguments (without the executable and script path).
 * @param loadDeps - Composition root.
 * @param io - Process boundary (defaults to the real process).
 * @returns The exit code (also reported through `io.setExitCode`).
 */
export async function runCli(
	args: readonly string[],
	loadDeps: CliDepsLoader,
	io: CliIo = createProcessIo(),
): Promise<ExitCode> {
	let code: ExitCode = ExitCode.Ok;
	const tracked: CliIo = {
		stdout: io.stdout,
		stderr: io.stderr,
		isTTY: io.isTTY,
		prompter: io.prompter,
		cwd: () => io.cwd(),
		setExitCode: (next) => {
			code = next;
		},
	};
	try {
		await createProgram(loadDeps, tracked).parseAsync([...args], {
			from: "user",
		});
	} catch (error) {
		if (error instanceof CommanderError) {
			code = error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
		} else {
			const message = error instanceof Error ? error.message : String(error);
			writeLine(io.stderr, theme.fail(`Unexpected error: ${message}`));
			code = ExitCode.OpError;
		}
	}
	io.setExitCode(code);
	return code;
}
