import type { ResolvedService, ResolvedStack } from "../resolve/resolved.model";
import { OpError } from "../shared/op-error";
import { err, ok, type Result } from "../shared/result";
import type { StackLink } from "../stack/stack.model";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variables a shell, dynamic loader or language runtime executes or trusts
 * (compared case-insensitively: zsh ties `path`, `fpath`… to their upper-case
 * forms). `env --format shell` output is meant for `eval`, and dotenv files
 * are loaded by tools, so a stack file from a cloned repo must never be able
 * to export one of these.
 */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"IFS",
	"ENV",
	"BASH_ENV",
	"CDPATH",
	"FPATH",
	"MANPATH",
	"PROMPT_COMMAND",
	"PROMPT",
	"RPROMPT",
	"PS0",
	"PS1",
	"PS2",
	"PS3",
	"PS4",
	"SHELLOPTS",
	"BASHOPTS",
	"GLOBIGNORE",
	"HISTFILE",
	"ZDOTDIR",
	"PRECMD_FUNCTIONS",
	"PREEXEC_FUNCTIONS",
	"TMPDIR",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"BROWSER",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_EXTRA_CA_CERTS",
	"BUN_OPTIONS",
	"DENO_DIR",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"PYTHONHOME",
	"PERL5OPT",
	"PERL5LIB",
	"PERLLIB",
	"RUBYOPT",
	"RUBYLIB",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"CLASSPATH",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_EXEC_PATH",
	"GIT_PAGER",
	"GIT_EDITOR",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"SUDO_ASKPASS",
	"DOCKER_HOST",
	"DOCKER_CONFIG",
	"LOCAINFRA_HOME",
	"LOCAINFRA_CATALOG_DIR",
]);

/** Name prefixes reserved like {@link RESERVED_ENV_NAMES} (loader injection, exported shell functions). */
export const RESERVED_ENV_PREFIXES: readonly string[] = [
	"LD_",
	"DYLD_",
	"BASH_FUNC_",
];

/**
 * @param name - A variable name.
 * @returns Whether `name` (case-insensitively) is one LocaInfra refuses to
 *   export: see {@link RESERVED_ENV_NAMES} and {@link RESERVED_ENV_PREFIXES}.
 */
export function isReservedEnvName(name: string): boolean {
	const upper = name.toUpperCase();
	return (
		RESERVED_ENV_NAMES.has(upper) ||
		RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
	);
}

/**
 * The primary connection variable of a service: the first key of its
 * definition's `exports` (e.g. `DATABASE_URL` for postgres).
 *
 * @param service - A resolved service.
 * @returns The variable name, or `undefined` when the service exports nothing.
 */
export function primaryExportName(
	service: ResolvedService,
): string | undefined {
	return Object.keys(service.exports)[0];
}

/**
 * Merges every service's evaluated `exports` into one variable map, in stack
 * (dependency) order, renaming each service's primary variable via
 * `link.names` (`{ redis: "REDIS_URL" }`).
 *
 * Two services exporting the same name with different values is an
 * `INVALID_STACK` error (rename one via `link.names`); identical values merge.
 * No variable may be a reserved shell/loader/runtime name
 * ({@link isReservedEnvName}): a rename to one is `INVALID_STACK`, a catalog
 * export of one is `INVALID_CATALOG`.
 * `link.names` entries for services not in the stack are ignored.
 *
 * @param resolved - The resolved stack.
 * @param link - The stack file's `link` section, if any.
 * @returns Variable name → value, or an error (messages never contain values).
 */
export function deriveEnv(
	resolved: ResolvedStack,
	link?: StackLink,
): Result<Record<string, string>> {
	const names = link?.names ?? {};
	const vars: Record<string, string> = {};
	const owners: Record<string, string> = {};

	for (const service of resolved.services) {
		const primary = primaryExportName(service);
		const rename = names[service.id];
		if (rename !== undefined && !ENV_NAME.test(rename)) {
			return err(
				new OpError(
					"INVALID_STACK",
					`link.names.${service.id} "${rename}" is not a valid variable name`,
					{
						details: {
							service: service.id,
							fix: "Use letters, digits and underscores, not starting with a digit.",
						},
					},
				),
			);
		}
		if (rename !== undefined && isReservedEnvName(rename)) {
			return err(
				new OpError(
					"INVALID_STACK",
					`link.names.${service.id} "${rename}" is a reserved variable name`,
					{
						details: {
							service: service.id,
							variable: rename,
							fix: `Pick an application-specific name such as ${service.id.toUpperCase().replaceAll("-", "_")}_URL; shell, loader and runtime variables (PATH, PROMPT_COMMAND, NODE_OPTIONS, LD_*, …) cannot be exported.`,
						},
					},
				),
			);
		}
		for (const [name, value] of Object.entries(service.exports)) {
			const target = name === primary && rename ? rename : name;
			if (isReservedEnvName(target)) {
				return err(
					new OpError(
						"INVALID_CATALOG",
						`Catalog definition "${service.catalogId}" exports the reserved variable ${target}`,
						{
							details: {
								service: service.id,
								catalogId: service.catalogId,
								variable: target,
								fix: "Fix the definition (catalog override or registry entry) to export application-specific names only.",
							},
						},
					),
				);
			}
			const owner = owners[target];
			if (owner !== undefined && vars[target] !== value) {
				return err(
					new OpError(
						"INVALID_STACK",
						`Services "${owner}" and "${service.id}" both export ${target}`,
						{
							details: {
								variable: target,
								services: [owner, service.id],
								fix: `Rename one of them with link.names (e.g. link.names.${service.id}: ${target}_2).`,
							},
						},
					),
				);
			}
			vars[target] = value;
			owners[target] ??= service.id;
		}
	}
	return ok(vars);
}
