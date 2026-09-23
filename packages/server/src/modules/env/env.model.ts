import { EnvFormatModel, EnvPreview, LinkEnvResult } from "@locainfra/core";
import { t } from "elysia";

/** `GET /api/projects/:project/env` query (the Environment screen's `fmt` + Reveal switch). */
export const EnvQuery = t.Object({
	format: t.Optional(
		t.Union(EnvFormatModel.anyOf, {
			default: "dotenv",
			description: "dotenv (.env) | shell (export lines) | json",
		}),
	),
	reveal: t.Optional(
		t.Boolean({
			default: false,
			description: "Include secret values (masked as •••••••• otherwise)",
		}),
	),
});
/** `GET /api/projects/:project/env` query. */
export type EnvQuery = typeof EnvQuery.static;

/** `POST /api/projects/:project/env/write` body ("Write to ./.env"). */
export const WriteEnvBody = t.Object({
	file: t.Optional(
		t.String({
			minLength: 1,
			description:
				"Env file relative to the project root; default link.file, else .env",
		}),
	),
});
/** `POST /api/projects/:project/env/write` body. */
export type WriteEnvBody = typeof WriteEnvBody.static;

/** Reference models of the env controller, registered under `Env.`. */
export const EnvModel = {
	query: EnvQuery,
	preview: EnvPreview,
	write: WriteEnvBody,
	written: LinkEnvResult,
};
