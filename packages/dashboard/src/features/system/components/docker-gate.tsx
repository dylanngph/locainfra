import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { useDockerAvailability } from "../hooks/use-docker-availability";
import { DockerUnavailable } from "./docker-unavailable";

/** Props of {@link DockerGate}. */
export interface DockerGateProps {
	/** The routed pages. */
	readonly children: ReactNode;
}

/**
 * Renders the pages, or the Docker-unavailable screen instead of them while
 * doctor reports a failing check. When Docker comes back (Start Docker,
 * Re-check, Refresh) every query is refetched and the route loaders re-run,
 * so pages that failed while Docker was down load normally.
 */
export function DockerGate({ children }: DockerGateProps) {
	const availability = useDockerAvailability();
	const queryClient = useQueryClient();
	const revalidator = useRevalidator();
	const wasUnavailable = useRef(false);
	const unavailable = availability.status === "unavailable";

	useEffect(() => {
		if (unavailable) {
			wasUnavailable.current = true;
			return;
		}
		if (!wasUnavailable.current) return;
		wasUnavailable.current = false;
		void queryClient.invalidateQueries({
			predicate: (query) => query.queryKey[0] !== "system",
		});
		void revalidator.revalidate();
	}, [unavailable, queryClient, revalidator]);

	if (availability.status === "unavailable")
		return <DockerUnavailable setup={availability.setup} />;
	return children;
}
