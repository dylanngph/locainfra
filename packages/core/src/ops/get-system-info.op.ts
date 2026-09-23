import type { GetSystemInfo } from "./ops.contract";
import type { SystemInfo } from "./ops.model";

/**
 * Docker engine and compose versions for the dashboard header. Never
 * throws: an unreachable daemon gives `docker: null`, a missing or failing
 * compose plugin `compose: null`.
 */
export const getSystemInfo: GetSystemInfo = async (deps) => {
	const [docker, compose] = await Promise.all([
		deps.docker.info().then(
			(info): SystemInfo["docker"] => ({
				version: info.serverVersion,
				apiVersion: info.apiVersion,
				...(info.platformName !== undefined && {
					platformName: info.platformName,
				}),
			}),
			() => null,
		),
		deps.compose.version().catch(() => null),
	]);
	return { docker, compose };
};
