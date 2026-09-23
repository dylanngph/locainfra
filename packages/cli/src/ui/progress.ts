import { log, spinner } from "@clack/prompts";
import { isOpError, type Progress, toProgressError } from "@locainfra/core";
import type { CliIo } from "../cli.types";
import { fixHint, writeJson, writeLine } from "./output";
import { glyph, theme } from "./theme";

/** Final state of a rendered progress stream. */
export interface ProgressOutcome {
	/** `false` when the stream emitted an `error` event or threw. */
	readonly ok: boolean;
	/** The terminal (`done`/`error`) event, when one was seen or synthesised. */
	readonly last?: Progress;
}

/** Presents {@link Progress} events. One implementation per output mode. */
export interface ProgressRenderer {
	/**
	 * Called once before the first event.
	 *
	 * @param title - What is happening, e.g. `Starting stack acme`.
	 */
	start(title: string): void;
	/**
	 * Called for every event, in order.
	 *
	 * @param event - The progress event.
	 */
	event(event: Progress): void;
	/**
	 * Called once after the stream ends (also when it ended without a terminal event).
	 *
	 * @param outcome - Final state.
	 */
	finish(outcome: ProgressOutcome): void;
}

const MAX_LOG_WIDTH = 72;

function label(event: Progress): string {
	return event.service ? `${event.service}: ${event.message}` : event.message;
}

function codeSuffix(event: Progress): string {
	return event.error ? ` ${theme.muted(`(${event.error.code})`)}` : "";
}

function errorFix(event: Progress): string | undefined {
	return fixHint(event.error?.details);
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** `--json` mode: one compact JSON object per event (NDJSON) on stdout. */
export class JsonProgressRenderer implements ProgressRenderer {
	/** @param io - Process streams. */
	constructor(private readonly io: CliIo) {}

	/** No header in JSON mode. */
	start(_title: string): void {}

	/** @param event - Written verbatim as one NDJSON line. */
	event(event: Progress): void {
		writeJson(this.io.stdout, event, false);
	}

	/** Nothing to flush. */
	finish(_outcome: ProgressOutcome): void {}
}

/** Non-interactive human mode (CI, pipes): one plain line per step. */
export class LineProgressRenderer implements ProgressRenderer {
	/** @param io - Process streams. */
	constructor(private readonly io: CliIo) {}

	/** @param title - Printed as a heading line. */
	start(title: string): void {
		writeLine(this.io.stdout, theme.strong(title));
	}

	/** @param event - Printed as one line; errors go to stderr. */
	event(event: Progress): void {
		switch (event.kind) {
			case "step":
				writeLine(this.io.stdout, `${glyph.step} ${label(event)}`);
				break;
			case "log":
				writeLine(this.io.stdout, theme.muted(`  ${label(event)}`));
				break;
			case "done":
				writeLine(this.io.stdout, theme.ok(`${glyph.ok} ${label(event)}`));
				break;
			case "error": {
				writeLine(
					this.io.stderr,
					`${theme.fail(`${glyph.fail} ${label(event)}`)}${codeSuffix(event)}`,
				);
				const fix = errorFix(event);
				if (fix) writeLine(this.io.stderr, theme.muted(`  fix: ${fix}`));
				break;
			}
		}
	}

	/** Nothing to flush. */
	finish(_outcome: ProgressOutcome): void {}
}

/** Interactive mode: a clack spinner per step, completed steps stay on screen. */
export class SpinnerProgressRenderer implements ProgressRenderer {
	private readonly spin: ReturnType<typeof spinner>;
	private current = "";
	private active = false;

	/** @param io - Process streams (the spinner draws on stdout). */
	constructor(private readonly io: CliIo) {
		this.spin = spinner({ output: io.stdout });
	}

	/** @param title - Initial spinner text. */
	start(title: string): void {
		this.current = title;
		this.spin.start(title);
		this.active = true;
	}

	/** @param event - Advances, annotates, completes or fails the spinner. */
	event(event: Progress): void {
		switch (event.kind) {
			case "step":
				if (this.active) this.spin.stop(this.current);
				this.current = label(event);
				this.spin.start(this.current);
				this.active = true;
				break;
			case "log":
				if (this.active) {
					this.spin.message(
						`${this.current} ${theme.muted(truncate(label(event), MAX_LOG_WIDTH))}`,
					);
				}
				break;
			case "done":
				if (this.active) this.spin.stop(this.current);
				this.active = false;
				log.success(theme.ok(label(event)), { output: this.io.stdout });
				break;
			case "error": {
				const text = `${theme.fail(label(event))}${codeSuffix(event)}`;
				if (this.active) this.spin.error(text);
				else log.error(text, { output: this.io.stdout });
				this.active = false;
				const fix = errorFix(event);
				if (fix)
					log.message(theme.muted(`fix: ${fix}`), { output: this.io.stdout });
				break;
			}
		}
	}

	/** Stops a spinner left running by a stream without a terminal event. */
	finish(_outcome: ProgressOutcome): void {
		if (this.active) {
			this.spin.stop(this.current);
			this.active = false;
		}
	}
}

/**
 * Picks the renderer for the current mode: JSON beats TTY detection.
 *
 * @param io - Process streams.
 * @param json - Whether `--json` is active.
 * @returns A renderer that never draws spinners in JSON or non-TTY mode.
 */
export function createProgressRenderer(
	io: CliIo,
	json: boolean,
): ProgressRenderer {
	if (json) return new JsonProgressRenderer(io);
	return io.isTTY
		? new SpinnerProgressRenderer(io)
		: new LineProgressRenderer(io);
}

/**
 * Drains a progress stream into a renderer. A thrown stream is converted into
 * a synthetic `error` event so callers always get an outcome.
 *
 * @param stream - Events from an op such as `upStack`.
 * @param renderer - Output mode.
 * @param title - Heading passed to {@link ProgressRenderer.start}.
 * @returns Whether the stream succeeded, and its terminal event.
 */
export async function renderProgress(
	stream: AsyncIterable<Progress>,
	renderer: ProgressRenderer,
	title: string,
): Promise<ProgressOutcome> {
	renderer.start(title);
	let ok = true;
	let last: Progress | undefined;
	try {
		for await (const event of stream) {
			renderer.event(event);
			if (event.kind === "error") ok = false;
			if (event.kind === "done" || event.kind === "error") last = event;
		}
	} catch (cause) {
		last = isOpError(cause)
			? { kind: "error", message: cause.message, error: toProgressError(cause) }
			: {
					kind: "error",
					message: `Unexpected failure: ${cause instanceof Error ? cause.message : String(cause)}`,
				};
		renderer.event(last);
		ok = false;
	}
	const outcome: ProgressOutcome = last ? { ok, last } : { ok };
	renderer.finish(outcome);
	return outcome;
}
