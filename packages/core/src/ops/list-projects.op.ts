import { join } from "node:path";
import type { ContainerSummary } from "../ports/docker.port";
import type { StateFile } from "../ports/state.port";
import { LABEL_INSTANCE, LABEL_SERVICE, LABEL_STACK } from "../render/labels";
import { ioErrorFrom } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadStack } from "../stack/loader";
import { PROJECT_STACK_FILE_NAME } from "../stack/stack.model";
import type { ListProjects } from "./ops.contract";
import type { ProjectSummary } from "./ops.model";
import { classifyContainer } from "./support/service-status";

/**
 * One summary per registered project, in registration order. A project whose
 * folder or file is missing or invalid still appears, with `issue` set and
 * counts at 0. Running / error counts come from the containers labelled
 * `locainfra.stack=<project>` (0 when Docker is unreachable). CPU and memory
 * are left out: only the server knows them (observer stats), and only while
 * the project is watched.
 *
 * @returns The summaries, or `IO` when state cannot be read.
 */
export const listProjects: ListProjects = async (deps) => {
	let state: StateFile;
	try {
		state = await deps.state.read();
	} catch (cause) {
		return err(
			ioErrorFrom("Could not read the LocaInfra project registry", cause),
		);
	}
	const summaries: ProjectSummary[] = [];
	for (const entry of state.projects) {
		const base = {
			name: entry.name,
			root: entry.root,
			...(entry.envFile !== undefined && { envFile: entry.envFile }),
		};
		const loaded = await loadStack(deps.files, {
			filePath: join(entry.root, PROJECT_STACK_FILE_NAME),
			root: entry.root,
		});
		if (!loaded.ok) {
			summaries.push({
				...base,
				serviceCount: 0,
				running: 0,
				errors: 0,
				types: [],
				issue: loaded.error.message,
			});
			continue;
		}
		const services = Object.entries(loaded.value.file.services);
		let containers: ContainerSummary[] = [];
		try {
			containers = await deps.containers.list({
				labels: { [LABEL_STACK]: entry.name },
			});
		} catch {
			containers = [];
		}
		let running = 0;
		let errors = 0;
		for (const [name] of services) {
			const container = containers.find(
				(c) => (c.labels[LABEL_INSTANCE] ?? c.labels[LABEL_SERVICE]) === name,
			);
			const { state: serviceState } = classifyContainer(container);
			if (serviceState === "running") running++;
			else if (serviceState === "error" || serviceState === "port-conflict") {
				errors++;
			}
		}
		summaries.push({
			...base,
			serviceCount: services.length,
			running,
			errors,
			types: services.map(([, service]) => service.type),
		});
	}
	return ok(summaries);
};
