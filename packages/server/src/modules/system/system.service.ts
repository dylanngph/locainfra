import type { GetSystemInfo, GetSystemInfoDeps } from "@locastack/core";
import type { SystemStatus } from "./system.model";

/** Docker/compose versions for the header status dot. No HTTP knowledge. */
export class SystemService {
	/**
	 * @param getSystemInfo - Core op.
	 * @param deps - Its ports.
	 * @param dashboardVersion - LocaStack version reported to the UI.
	 */
	constructor(
		private readonly getSystemInfo: GetSystemInfo,
		private readonly deps: GetSystemInfoDeps,
		private readonly dashboardVersion: string,
	) {}

	/** @returns Versions; `docker`/`compose` are `null` when unreachable/missing. */
	async status(): Promise<SystemStatus> {
		const info = await this.getSystemInfo(this.deps);
		return { ...info, dashboardVersion: this.dashboardVersion };
	}
}
