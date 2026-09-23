import { type Static, Type } from "@sinclair/typebox";

/** Docker daemon identity as reported by the Engine API `/version` + `/info`. */
export const DockerInfo = Type.Object({
	serverVersion: Type.String(),
	apiVersion: Type.String(),
	platformName: Type.Optional(
		Type.String({ description: "e.g. Docker Desktop 4.82.0 (212345)" }),
	),
	os: Type.String(),
	arch: Type.String(),
});
/** Docker daemon identity. */
export type DockerInfo = Static<typeof DockerInfo>;

/** Reads daemon identity; failure to reach the daemon rejects the promise. */
export interface DockerInfoPort {
	/** Fetches daemon version and platform information. */
	info(): Promise<DockerInfo>;
}

/** Container health as surfaced by Docker (`none` when no healthcheck is defined). */
export const ContainerHealth = Type.Union([
	Type.Literal("healthy"),
	Type.Literal("unhealthy"),
	Type.Literal("starting"),
	Type.Literal("none"),
]);
/** Container health as surfaced by Docker. */
export type ContainerHealth = Static<typeof ContainerHealth>;

/** A published port mapping on the host (always bound to 127.0.0.1 for LocaInfra services). */
export const PortMapping = Type.Object({
	host: Type.Integer(),
	container: Type.Integer(),
});
/** A published port mapping. */
export type PortMapping = Static<typeof PortMapping>;

/** Summary of one container as returned by the Engine API list endpoint. */
export const ContainerSummary = Type.Object({
	id: Type.String(),
	name: Type.String({
		description: "Container name without the leading slash",
	}),
	image: Type.String(),
	state: Type.String({
		description:
			"Docker state: created | running | paused | restarting | removing | exited | dead",
	}),
	health: Type.Optional(ContainerHealth),
	labels: Type.Record(Type.String(), Type.String()),
	ports: Type.Array(PortMapping),
});
/** Summary of one container. */
export type ContainerSummary = Static<typeof ContainerSummary>;

/** Filter for {@link ContainerReader.list}. */
export interface ContainerFilter {
	/** Only containers carrying all of these labels (exact value match). */
	readonly labels?: Readonly<Record<string, string>>;
}

/** Read-only container listing (Engine API). */
export interface ContainerReader {
	/**
	 * Lists containers (running and stopped) matching the filter.
	 *
	 * @param filter - Label filter.
	 */
	list(filter: ContainerFilter): Promise<ContainerSummary[]>;
}

/** Finds the Docker Engine socket (`DOCKER_HOST` → docker context → platform default). */
export interface SocketLocator {
	/** @returns The socket path, or `null` when none is found. */
	locate(): Promise<string | null>;
}
