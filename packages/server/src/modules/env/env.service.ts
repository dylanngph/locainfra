import type { EnvPreview, LinkEnvResult } from "@locastack/core";
import type { ServerOps, ServerPorts } from "../../deps";
import { unwrap } from "../../shared/unwrap";
import type { EnvQuery, WriteEnvBody } from "./env.model";

/** Environment screen: preview and "Write to ./.env". No HTTP knowledge. */
export class EnvService {
	/**
	 * @param ops - `envPreview` and `linkEnv`.
	 * @param ports - Ports passed to the ops.
	 */
	constructor(
		private readonly ops: Pick<ServerOps, "envPreview" | "linkEnv">,
		private readonly ports: ServerPorts,
	) {}

	/**
	 * @param project - Project name.
	 * @param query - Format (default dotenv) and reveal (default false).
	 * @returns The preview.
	 * @throws OpError `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`, `INVALID_STACK`.
	 */
	async preview(project: string, query: EnvQuery): Promise<EnvPreview> {
		return unwrap(
			await this.ops.envPreview(this.ports, {
				project,
				format: query.format ?? "dotenv",
				reveal: query.reveal ?? false,
			}),
		);
	}

	/**
	 * @param project - Project name.
	 * @param body - Target file (default `link.file`, else `.env`).
	 * @returns Written path and variable count.
	 * @throws OpError `PROJECT_NOT_FOUND`, `INVALID_INPUT` (file escapes the root).
	 */
	async write(project: string, body: WriteEnvBody): Promise<LinkEnvResult> {
		return unwrap(
			await this.ops.linkEnv(this.ports, {
				project,
				...(body.file === undefined ? {} : { file: body.file }),
			}),
		);
	}
}
