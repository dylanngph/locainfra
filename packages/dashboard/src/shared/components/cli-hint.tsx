import { copyText } from "@/shared/lib/clipboard";
import { cliCommandLine, shortPath } from "@/shared/lib/shell";

/** Props of {@link CliHint}. */
export interface CliHintProps {
	/** A command that exists in the `locastack` CLI, e.g. `locastack up`. */
	readonly command: string;
	/** Project folder the command runs in; shown short, copied quoted. */
	readonly cwd?: string;
}

/**
 * The `$ <command> [Copy]` bar that ends every page with a real CLI
 * equivalent (up/down/env/doctor only). The command is the main text; the
 * folder is a muted prefix (full path on hover) and is `cd '<root>' &&`-ed
 * into the copied line.
 */
export function CliHint({ command, cwd }: CliHintProps) {
	const line = cliCommandLine(command, cwd);
	return (
		<div className="flex items-center gap-2.5 rounded-control border bg-subtle py-[5px] pr-[5px] pl-3 font-mono text-[#404040] text-[12px] leading-normal">
			{cwd ? (
				<span
					className="max-w-[40%] flex-none truncate text-[#a3a3a3]"
					title={cwd}
				>
					{shortPath(cwd)}
				</span>
			) : null}
			<span className="flex-none text-[#a3a3a3]" aria-hidden>
				$
			</span>
			<code className="min-w-0 flex-1 truncate" title={line}>
				{command}
			</code>
			<button
				type="button"
				onClick={() => void copyText(line, "Command copied")}
				className="h-6 flex-none rounded-[4px] border bg-background px-2 font-medium font-sans text-[11px] hover:bg-muted"
			>
				Copy
			</button>
		</div>
	);
}
