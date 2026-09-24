/**
 * POSIX single-quotes a shell word, so paths with spaces, `$`, or quotes copy
 * safely: `it's here` → `'it'\''s here'`.
 *
 * @param word - Raw argument.
 * @returns The quoted word.
 */
export function shellQuote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The string a CLI hint copies: `cd '<root>' && <command>`, or just the
 * command when there is no folder.
 *
 * @param command - A `locastack …` command.
 * @param cwd - Absolute project folder the command runs in.
 * @returns Paste-ready shell line.
 */
export function cliCommandLine(command: string, cwd?: string): string {
	return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

/**
 * Short form of an absolute folder for display: the last segment behind an
 * ellipsis (`/Users/me/dev/shop` → `…/shop`). The full path stays available
 * as a tooltip.
 *
 * @param path - Absolute path.
 * @returns Display label.
 */
export function shortPath(path: string): string {
	const segments = path.split("/").filter(Boolean);
	const leaf = segments.at(-1);
	if (!leaf) return path || "/";
	return segments.length === 1 ? `/${leaf}` : `…/${leaf}`;
}
