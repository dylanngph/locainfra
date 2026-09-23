import type { EnvFormat } from "./env-formatter";
import { getEnvFormatter } from "./registry";

/** A variable tagged with the service it belongs to (see `deriveEnvLines`). */
export interface GroupedEnvLine {
	/** Variable name. */
	readonly key: string;
	/** Value, already masked when needed. */
	readonly value: string;
	/** Service instance name. */
	readonly service: string;
	/** Catalog id of the service. */
	readonly type: string;
}

/**
 * Serializes variables in `format`. `dotenv` and `shell` output groups the
 * lines of each service under a `# <service> (<type>)` comment, groups
 * separated by a blank line; `json` is one flat object (JSON has no comments).
 *
 * @param format - Output format.
 * @param lines - Variables in order (lines of one service are contiguous).
 * @returns The text, ending with a newline when non-empty.
 */
export function formatGroupedEnv(
	format: EnvFormat,
	lines: readonly GroupedEnvLine[],
): string {
	const formatter = getEnvFormatter(format);
	if (format === "json") {
		return formatter.format(
			Object.fromEntries(lines.map((line) => [line.key, line.value])),
		);
	}
	const groups: Array<{ header: string; vars: Record<string, string> }> = [];
	for (const line of lines) {
		const header = `# ${line.service} (${line.type})`;
		let group = groups.at(-1);
		if (group === undefined || group.header !== header) {
			group = { header, vars: {} };
			groups.push(group);
		}
		group.vars[line.key] = line.value;
	}
	return groups
		.map((group) => `${group.header}\n${formatter.format(group.vars)}`)
		.join("\n");
}
