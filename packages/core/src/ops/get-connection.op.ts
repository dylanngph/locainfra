import { maskSecrets } from "../env/deriver";
import type { ResolvedService } from "../resolve/resolved.model";
import { ok } from "../shared/result";
import { loadProject } from "./load-project.op";
import type { GetConnection } from "./ops.contract";
import {
	type ConnectionDetail,
	type ConnectionSnippets,
	MASKED_SECRET,
} from "./ops.model";
import { projectEnvLines } from "./support/env-lines";
import { readProjectView } from "./support/project-view";
import { findService } from "./support/service-input";

/** Placeholder in catalog snippets replaced by the primary export's final name. */
export const SNIPPET_KEY_PLACEHOLDER = "KEY";

const KEY_PATTERN = new RegExp(`\\b${SNIPPET_KEY_PLACEHOLDER}\\b`, "g");

/**
 * @param key - A config or secret name, e.g. `POSTGRES_USER`.
 * @returns The Connect-tab label, e.g. `User`.
 */
export function connectionLabel(key: string): string {
	const upper = key.toUpperCase();
	if (/(^|_)(USER|USERNAME)$/.test(upper)) return "User";
	if (/(^|_)(DB|DATABASE)$/.test(upper)) return "Database";
	if (/(^|_)BUCKETS?$/.test(upper)) return "Buckets";
	if (/PASSWORD$/.test(upper)) return "Password";
	if (/TOKEN$/.test(upper)) return "Token";
	return key;
}

function details(
	service: ResolvedService,
	reveal: boolean,
): ConnectionDetail[] {
	const rows: ConnectionDetail[] = [
		{ k: "Host", v: "127.0.0.1" },
		{ k: "Port", v: String(service.hostPort) },
	];
	for (const [key, value] of Object.entries(service.config)) {
		rows.push({ k: connectionLabel(key), v: value });
	}
	for (const [key, value] of Object.entries(service.secrets)) {
		rows.push({ k: connectionLabel(key), v: reveal ? value : MASKED_SECRET });
	}
	rows.push({ k: "Container", v: service.containerName });
	return rows;
}

/**
 * Connect-tab data for one service: the primary export (definition
 * `primaryExport` under its final name, as in `envPreview`), every export,
 * a details grid (Host, Port, config values, secrets, Container) and the
 * "Use in code" snippets with `KEY` replaced by the primary export's name.
 * Secret values are masked unless `reveal`. Read-only.
 *
 * @returns The connection info; `SERVICE_NOT_FOUND` plus the errors of `envPreview`.
 */
export const getConnection: GetConnection = async (deps, input) => {
	const stack = await loadProject(deps, input);
	if (!stack.ok) return stack;
	const found = findService(stack.value, input.name);
	if (!found.ok) return found;
	const view = await readProjectView(deps, stack.value, "placeholder");
	if (!view.ok) return view;
	const lines = projectEnvLines(view.value.resolved, stack.value, input.reveal);
	if (!lines.ok) return lines;
	const service = view.value.resolved.services.find(
		(s) => s.name === input.name,
	);
	const own = lines.value.filter((line) => line.service === input.name);
	const primaryLine = own.find((line) => line.primary) ?? own[0];
	const primary = primaryLine
		? { key: primaryLine.key, value: primaryLine.value }
		: { key: "", value: "" };
	const snippets: ConnectionSnippets = {
		env: own.map((line) => `${line.key}=${line.value}`).join("\n"),
	};
	for (const lang of ["node", "python", "go"] as const) {
		const template = service?.definition.snippets?.[lang];
		if (template !== undefined) {
			snippets[lang] = template.replace(KEY_PATTERN, primary.key);
		}
	}
	return ok({
		primary,
		exports: own.map(({ key, value }) => ({ key, value })),
		details:
			service === undefined
				? []
				: details(service, input.reveal).map((row) => ({
						...row,
						v: input.reveal
							? row.v
							: maskSecrets(
									row.v,
									Object.values(service.secrets),
									MASKED_SECRET,
								),
					})),
		snippets,
	});
};
