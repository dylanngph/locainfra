import { api, unwrap } from "@/shared/lib/api";
import type { EnvFormat } from "./env.queries";

/**
 * Writes the variables into the project's env file (marker block).
 *
 * @param project - Project name.
 * @returns Written path and variable count.
 */
export const writeEnv = (project: string) =>
	unwrap(api.api.projects({ project }).env.write.post({}));

/**
 * The preview text with secrets revealed (Copy / Download).
 *
 * @param project - Project name.
 * @param format - Output format.
 * @returns Serialized variables.
 */
export const revealedEnvText = async (project: string, format: EnvFormat) =>
	(
		await unwrap(
			api.api
				.projects({ project })
				.env.get({ query: { format, reveal: true } }),
		)
	).text;
