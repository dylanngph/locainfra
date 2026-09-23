import type {
	Clock,
	ContainerStreams,
	DockerEvent,
	EventFilter,
	LogLine,
	LogOptions,
	StatsSample,
} from "@locainfra/core";
import { SystemClock } from "../util/clock";
import { openDockerStream, parseJsonLines } from "./body-stream";
import { buildEventsQuery, toDockerEvent } from "./event-mapper";
import { LogDemuxer } from "./log-demuxer";
import {
	buildLogsQuery,
	isMultiplexedLogStream,
	LogLineAssembler,
} from "./log-lines";
import { toStatsSample } from "./stats-mapper";
import type { DockerTransport } from "./transport";

/** Options for {@link DockerContainerStreams}. */
export interface DockerContainerStreamsOptions {
	/** Timestamps samples/events whose frame carries no usable time (default system clock). */
	readonly clock?: Clock;
}

/**
 * {@link ContainerStreams} over the Engine API (unix socket via Bun `fetch`).
 *
 * Each call opens its own HTTP connection. Aborting the signal, breaking out
 * of the `for await`, or the daemon closing the stream all close the
 * connection; an abort ends the iterator without throwing. An unreachable
 * daemon rejects with `DOCKER_UNREACHABLE`, a missing container with
 * `SERVICE_NOT_FOUND`. Read only: nothing here mutates containers.
 */
export class DockerContainerStreams implements ContainerStreams {
	readonly #transport: DockerTransport;
	readonly #clock: Clock;

	/**
	 * @param transport - How requests reach the daemon.
	 * @param options - Clock override.
	 */
	constructor(
		transport: DockerTransport,
		options: DockerContainerStreamsOptions = {},
	) {
		this.#transport = transport;
		this.#clock = options.clock ?? new SystemClock();
	}

	/**
	 * `GET /containers/{id}/logs?follow=&stdout=1&stderr=1&timestamps=1&tail=&since=`,
	 * demultiplexed (or read raw for TTY containers) and yielded per line with
	 * the Docker timestamp parsed into `at`.
	 *
	 * @param id - Container id or name.
	 * @param options - Follow, tail, since and abort signal.
	 * @returns Log lines in arrival order.
	 */
	async *logs(id: string, options: LogOptions): AsyncGenerator<LogLine> {
		const path = `/containers/${encodeURIComponent(id)}/logs?${buildLogsQuery(options)}`;
		const signal = options.signal;
		yield* openDockerStream(
			this.#transport,
			{ path, signal, container: id },
			async function* ({ contentType, chunks }) {
				const assembler = new LogLineAssembler();
				const decoder = new TextDecoder();
				let demuxer: LogDemuxer | null | undefined;
				for await (const chunk of chunks) {
					demuxer ??= isMultiplexedLogStream(contentType, chunk)
						? new LogDemuxer()
						: null;
					yield* assembler.push(
						demuxer === null
							? [
									{
										stream: "stdout",
										text: decoder.decode(chunk, { stream: true }),
									},
								]
							: demuxer.push(chunk),
					);
				}
				if (signal?.aborted) return;
				if (demuxer) yield* assembler.push(demuxer.end());
				else
					yield* assembler.push([{ stream: "stdout", text: decoder.decode() }]);
				yield* assembler.end();
			},
		);
	}

	/**
	 * `GET /containers/{id}/stats?stream=1`, one {@link StatsSample} per frame
	 * (about one per second while the container runs).
	 *
	 * @param id - Container id or name.
	 * @param signal - Aborts the stream.
	 * @returns Samples in arrival order.
	 */
	async *stats(id: string, signal: AbortSignal): AsyncGenerator<StatsSample> {
		const clock = this.#clock;
		yield* openDockerStream(
			this.#transport,
			{
				path: `/containers/${encodeURIComponent(id)}/stats?stream=1`,
				signal,
				container: id,
			},
			async function* ({ chunks }) {
				for await (const frame of parseJsonLines(chunks)) {
					const sample = toStatsSample(frame, clock.now());
					if (sample !== null) yield sample;
				}
			},
		);
	}

	/**
	 * `GET /events?filters={"type":["container"],"label":[…]}` as JSON lines.
	 * See {@link buildEventsQuery} for label semantics (default: every
	 * container carrying `locainfra.stack`).
	 *
	 * @param filter - Label filter.
	 * @param signal - Aborts the stream.
	 * @returns Container events in arrival order.
	 */
	async *events(
		filter: EventFilter,
		signal: AbortSignal,
	): AsyncGenerator<DockerEvent> {
		const clock = this.#clock;
		yield* openDockerStream(
			this.#transport,
			{ path: `/events?${buildEventsQuery(filter)}`, signal },
			async function* ({ chunks }) {
				for await (const raw of parseJsonLines(chunks)) {
					const event = toDockerEvent(raw, clock.now());
					if (event !== null) yield event;
				}
			},
		);
	}
}
