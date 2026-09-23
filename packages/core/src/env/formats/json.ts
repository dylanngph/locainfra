import type { EnvFormatter, EnvVars } from "./env-formatter";

/** A pretty-printed JSON object of all variables. */
export const jsonFormatter: EnvFormatter = {
	id: "json",
	format(vars: EnvVars): string {
		return `${JSON.stringify(vars, null, 2)}\n`;
	},
};
