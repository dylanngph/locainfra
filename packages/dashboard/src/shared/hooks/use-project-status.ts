import type { ProjectStatus, ServiceStatus } from "@locainfra/server";
import { useMemo } from "react";
import { useLiveMode } from "@/shared/lib/live/live-mode";
import { useObserverStore } from "@/shared/lib/observer/observer-store";

/**
 * Freshest known status of a project with the optimistic states of in-flight
 * actions overlaid. While Live mode is on (the project layout keeps
 * `status:<project>` subscribed) the observer's snapshot wins; otherwise, or
 * until the first snapshot arrives, the loaded status is used. This hook
 * never subscribes by itself.
 *
 * @param project - Project name.
 * @param fallback - Status from `GET /api/projects/:project`.
 * @returns The status, or `undefined` when nothing is known yet.
 */
export function useProjectStatus(
	project: string,
	fallback: ProjectStatus | undefined,
): ProjectStatus | undefined {
	const live = useLiveMode(project);
	const snapshot = useObserverStore((s) =>
		live ? s.status[project] : undefined,
	);
	const pending = useObserverStore((s) => s.pending);
	return useMemo(() => {
		const base = snapshot ?? fallback;
		if (!base) return undefined;
		let changed = false;
		const services = base.services.map((service): ServiceStatus => {
			const override = pending[`${project}/${service.name}`];
			if (!override || override === service.state) return service;
			changed = true;
			return { ...service, state: override };
		});
		return changed ? { ...base, services } : base;
	}, [snapshot, fallback, pending, project]);
}
