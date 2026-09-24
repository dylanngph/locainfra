import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ApiRequestError, errorMessage } from "@/shared/lib/api-error";
import { trackOp } from "@/shared/lib/track-op";
import { type RuntimeProvider, startDocker } from "../api/system.api";
import { SYSTEM_KEY } from "../api/system.queries";

/** Why the last Start Docker attempt failed. */
export interface StartDockerFailure {
	/** What went wrong. */
	readonly message: string;
	/** Manual remedy (`details.fix`), when the server gave one. */
	readonly fix?: string;
}

/** State and action of the Start Docker button. */
export interface StartDockerAction {
	/** A start is in flight (button disabled). */
	readonly starting: boolean;
	/** Failure of the last attempt, cleared on the next one. */
	readonly failure: StartDockerFailure | undefined;
	/** Starts the runtime; resolves `true` when the op ended with `done`. */
	start(provider?: RuntimeProvider): Promise<boolean>;
}

const fixOf = (details: Readonly<Record<string, unknown>> | undefined) =>
	typeof details?.fix === "string" ? details.fix : undefined;

/**
 * Start Docker: `POST /api/system/docker/start`, progress in the op toast,
 * then one re-fetch of `GET /api/system` and `GET /api/system/setup` (the
 * screen leaves by itself once they report Docker ready).
 *
 * @returns The action and its state.
 */
export function useStartDocker(): StartDockerAction {
	const queryClient = useQueryClient();
	const [starting, setStarting] = useState(false);
	const [failure, setFailure] = useState<StartDockerFailure>();

	const start = useCallback(
		async (provider?: RuntimeProvider) => {
			setStarting(true);
			setFailure(undefined);
			try {
				const opId = await startDocker(provider);
				const event = await trackOp(opId, {
					title: "Starting Docker…",
					queryClient,
					invalidate: [{ queryKey: SYSTEM_KEY }],
				});
				if (event.kind === "done") return true;
				const fix = fixOf(event.error?.details);
				setFailure({
					message: event.error?.message ?? event.message,
					...(fix ? { fix } : {}),
				});
				return false;
			} catch (error) {
				const fix =
					error instanceof ApiRequestError ? fixOf(error.details) : undefined;
				setFailure({ message: errorMessage(error), ...(fix ? { fix } : {}) });
				await queryClient.invalidateQueries({ queryKey: SYSTEM_KEY });
				return false;
			} finally {
				setStarting(false);
			}
		},
		[queryClient],
	);

	return { starting, failure, start };
}
