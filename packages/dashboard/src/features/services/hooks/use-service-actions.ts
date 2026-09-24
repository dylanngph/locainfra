import type { ServiceState } from "@locastack/server";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
	invalidationFor,
	type OpScope,
} from "@/features/projects/api/project-invalidation";
import { errorMessage } from "@/shared/lib/api-error";
import { copyText } from "@/shared/lib/clipboard";
import {
	pendingKey,
	useObserverStore,
} from "@/shared/lib/observer/observer-store";
import { trackOp } from "@/shared/lib/track-op";
import {
	patchService,
	revealedPrimaryUrl,
	runServiceAction,
	type ServiceAction,
} from "../api/services.api";

const OPTIMISTIC: Readonly<Record<ServiceAction, ServiceState>> = {
	start: "starting",
	stop: "stopped",
	restart: "starting",
};

const TITLE: Readonly<Record<ServiceAction, (name: string) => string>> = {
	start: (name) => `Starting ${name}…`,
	stop: (name) => `Stopping ${name}…`,
	restart: (name) => `Restarting ${name}…`,
};

/** Actions on the services of one project, with optimistic state and progress toasts. */
export interface ServiceActions {
	start(name: string): Promise<boolean>;
	stop(name: string): Promise<boolean>;
	restart(name: string): Promise<boolean>;
	/** "Use port N": PATCH the port (the server re-ups the service on it). */
	movePort(name: string, port: number): Promise<boolean>;
	/** Copies the primary export with its secret revealed. */
	copyUrl(name: string): Promise<void>;
}

/**
 * Service actions of a project. Each shows an optimistic state, follows the
 * op's progress in a toast and resolves `true` when it finished with `done`.
 *
 * @param project - Project name.
 * @returns The actions.
 */
export function useServiceActions(project: string): ServiceActions {
	const queryClient = useQueryClient();
	const setPending = useObserverStore((s) => s.setPending);

	const follow = useCallback(
		async (
			name: string,
			optimistic: ServiceState,
			title: string,
			scope: OpScope["kind"] & ("service-state" | "service-config"),
			start: () => Promise<string>,
		): Promise<boolean> => {
			const key = pendingKey(project, name);
			setPending(key, optimistic);
			try {
				const opId = await start();
				const result = await trackOp(opId, {
					title,
					queryClient,
					invalidate: invalidationFor({ kind: scope, project, service: name }),
				});
				return result.kind === "done";
			} catch (error) {
				toast.error(errorMessage(error));
				return false;
			} finally {
				setPending(key, null);
			}
		},
		[project, queryClient, setPending],
	);

	return useMemo(() => {
		const run = (name: string, action: ServiceAction) =>
			follow(
				name,
				OPTIMISTIC[action],
				TITLE[action](name),
				"service-state",
				() => runServiceAction(project, name, action),
			);
		return {
			start: (name) => run(name, "start"),
			stop: (name) => run(name, "stop"),
			restart: (name) => run(name, "restart"),
			movePort: (name, port) =>
				follow(
					name,
					"starting",
					`Moving ${name} to port ${port}…`,
					"service-config",
					() => patchService(project, name, { port }),
				),
			copyUrl: async (name) => {
				try {
					await copyText(
						await revealedPrimaryUrl(project, name),
						`Copied ${name} URL`,
					);
				} catch (error) {
					toast.error(errorMessage(error));
				}
			},
		};
	}, [follow, project]);
}
