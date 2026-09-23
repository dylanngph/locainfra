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
 * The primary connection variable of a service: its definition's
 * `primaryExport` (e.g. `DATABASE_URL` for postgres).
 *
 * @param service - A resolved service.
 * @returns The variable name, or `undefined` when the service exports nothing.
 */
export function primaryExportName(
	service: ResolvedService,
): string | undefined {
	const name = service.definition.primaryExport;
	return Object.hasOwn(service.exports, name) ? name : undefined;
}

/** One exported variable with the service it came from. */
export interface DerivedEnvLine {
	/** Final variable name (renamed by `link.names`, or `<INSTANCE>_`-prefixed on a collision). */
	readonly key: string;
	/** Evaluated value (contains secrets; mask before showing it). */
	readonly value: string;
	/** Instance name of the service that exports it. */
	readonly service: string;
	/** Catalog id of that service. */
	readonly type: string;
	/** The variable's name in the catalog definition's `exports`. */
	readonly sourceKey: string;
	/** Whether this is the service's `primaryExport`. */
	readonly primary: boolean;
}

/**
 * The prefix a service's variables get when one of them collides with an
 * earlier service's: the instance name upper-cased, every character other
 * than `A-Z0-9` as `_`, then `_`.
 *
 * @param instance - Service instance name, e.g. `main-db`.
 * @returns e.g. `MAIN_DB_`.
 */
export function envKeyPrefix(instance: string): string {
	return `${instance.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
}

function invalidName(
	service: string,
	variable: string,
	message: string,
	fix: string,
) {
	return err(
		new OpError("INVALID_STACK", message, {
			details: { service, variable, fix },
		}),
	);
}

function orderServices(
	resolved: ResolvedStack,
	order: readonly string[] | undefined,
): ResolvedService[] {
	if (order === undefined) return [...resolved.services];
	const rank = new Map(order.map((name, index) => [name, index]));
	return [...resolved.services].sort(
		(a, b) =>
			(rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
	);
}

/**
 * Lists every service's evaluated `exports` as variables, service by
 * service. Naming rules:
 *
 * 1. `link.names.<instance>` renames the service's primary export (never prefixed).
 * 2. Otherwise, when any of a service's variable names is already taken by an
 *    earlier service, every non-renamed variable of that service gets the
 *    {@link envKeyPrefix} (`DATABASE_URL` → `EVENTS_DATABASE_URL`).
 * 3. A final name that is still taken is `INVALID_STACK` (rename via `link.names`).
 *
 * No variable may be a reserved shell/loader/runtime name
 * ({@link isReservedEnvName}): a rename or prefix producing one is
 * `INVALID_STACK`, a catalog export of one is `INVALID_CATALOG`.
 * `link.names` entries for services not in the stack are ignored.
 *
 * @param resolved - The resolved stack.
 * @param link - The stack file's `link` section, if any.
 * @param order - Instance names in stack file order (default: the resolved,
 *   dependency order). "Earlier" in rule 2 follows this order.
 * @returns The variables in order, or an error (messages never contain values).
 */
export function deriveEnvLines(
	resolved: ResolvedStack,
	link?: StackLink,
	order?: readonly string[],
): Result<DerivedEnvLine[]> {
	const names = link?.names ?? {};
	const lines: DerivedEnvLine[] = [];
	const owners = new Map<string, string>();

	for (const service of orderServices(resolved, order)) {
		const primary = primaryExportName(service);
		const rename = names[service.name];
		if (rename !== undefined && !ENV_NAME.test(rename)) {
			return invalidName(
				service.name,
				rename,
				`link.names.${service.name} "${rename}" is not a valid variable name`,
				"Use letters, digits and underscores, not starting with a digit.",
			);
		}
		if (rename !== undefined && isReservedEnvName(rename)) {
			return invalidName(
				service.name,
				rename,
				`link.names.${service.name} "${rename}" is a reserved variable name`,
				`Pick an application-specific name such as ${envKeyPrefix(service.name)}URL; shell, loader and runtime variables (PATH, PROMPT_COMMAND, NODE_OPTIONS, LD_*, …) cannot be exported.`,
			);
		}
		const planned = Object.entries(service.exports).map(
			([sourceKey, value]) => {
				const renamed = sourceKey === primary && rename !== undefined;
				return {
					sourceKey,
					value,
					renamed,
					base: renamed ? rename : sourceKey,
				};
			},
		);
		for (const { base, renamed } of planned) {
			if (!renamed && isReservedEnvName(base)) {
				return err(
					new OpError(
						"INVALID_CATALOG",
						`Catalog definition "${service.type}" exports the reserved variable ${base}`,
						{
							details: {
								service: service.name,
								catalogId: service.type,
								variable: base,
								fix: "Fix the definition (catalog override or registry entry) to export application-specific names only.",
							},
						},
					),
				);
			}
		}
		const collides = planned.some(
			({ base, renamed }) => !renamed && owners.has(base),
		);
		const prefix = collides ? envKeyPrefix(service.name) : "";
		for (const { sourceKey, value, renamed, base } of planned) {
			const key = renamed ? base : `${prefix}${base}`;
			if (isReservedEnvName(key)) {
				return invalidName(
					service.name,
					key,
					`Variable ${key} of "${service.name}" is a reserved variable name`,
					`Rename the service "${service.name}" or set link.names.${service.name}.`,
				);
			}
			const owner = owners.get(key);
			if (owner !== undefined) {
				return err(
					new OpError(
						"INVALID_STACK",
						`Services "${owner}" and "${service.name}" both export ${key}`,
						{
							details: {
								variable: key,
								services: [owner, service.name],
								fix: `Rename one of them with link.names (e.g. link.names.${service.name}: ${envKeyPrefix(service.name)}URL) or rename a service.`,
							},
						},
					),
				);
			}
			owners.set(key, service.name);
			lines.push({
				key,
				value,
				service: service.name,
				type: service.type,
				sourceKey,
				primary: sourceKey === primary,
			});
		}
	}
	return ok(lines);
}

/**
 * {@link deriveEnvLines} as one variable map (what `locainfra env` prints).
 *
 * @param resolved - The resolved stack.
 * @param link - The stack file's `link` section, if any.
 * @param order - Instance names in stack file order.
 * @returns Variable name → value, or an error (messages never contain values).
 */
export function deriveEnv(
	resolved: ResolvedStack,
	link?: StackLink,
	order?: readonly string[],
): Result<Record<string, string>> {
	const lines = deriveEnvLines(resolved, link, order);
	if (!lines.ok) return lines;
	return ok(
		Object.fromEntries(lines.value.map((line) => [line.key, line.value])),
	);
}

/**
 * Replaces every occurrence of the given secret values in `value` with
 * `mask` (longest first, so a secret containing another is masked whole).
 *
 * @param value - A value that may embed secrets (e.g. a connection URL).
 * @param secrets - Secret values; empty strings are ignored.
 * @param mask - Replacement text.
 * @returns The masked value.
 */
export function maskSecrets(
	value: string,
	secrets: Iterable<string>,
	mask: string,
): string {
	const sorted = [...new Set(secrets)]
		.filter((secret) => secret !== "")
		.sort((a, b) => b.length - a.length);
	let out = value;
	for (const secret of sorted) out = out.split(secret).join(mask);
	return out;
}
