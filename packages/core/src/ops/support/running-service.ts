import type { ServiceDefinition } from "../../catalog/catalog.model";
import { maskSecrets } from "../../env/deriver";
import { serviceContainerName } from "../../paths/layout";
import type { ContainerInspector } from "../../ports/docker.port";
import type { ExecResult } from "../../ports/exec.port";
import { collectStackSecrets } from "../../render/secret-refs";
import type {
	ResolvedService,
	ResolvedStack,
} from "../../resolve/resolved.model";
import { serviceTemplateContext } from "../../resolve/service-context";
import { isOpError, OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import type { Stack, StackServiceEntry } from "../../stack/stack.model";
import type { TemplateContext } from "../../template/template.model";
import { loadProject } from "../load-project.op";
import type { ProjectViewDeps, ServiceRef } from "../ops.contract";
import { MASKED_SECRET } from "../ops.model";
import { loadDefinitions } from "./catalog";
import { readProjectView } from "./project-view";
import { findDefinition, findService } from "./service-input";

/** Ports needed by {@link loadRunningService}. */
export interface RunningServiceDeps extends ProjectViewDeps {
	/** Container inspect (running check). */
	readonly inspector: ContainerInspector;
}

/**
 * A service of a registered project whose container is running.
 *
 * @typeParam T - What the caller's precondition extracted.
 */
export interface RunningService<T> {
	/** Value returned by the precondition (e.g. the definition's `data` block). */
	readonly checked: T;
	/** The project stack. */
	readonly stack: Stack;
	/** The service's stack entry. */
	readonly entry: StackServiceEntry;
	/** Its catalog definition. */
	readonly definition: ServiceDefinition;
	/** The resolved stack (holds secrets; never log). */
	readonly resolved: ResolvedStack;
	/** The resolved service (holds secrets; never log). */
	readonly service: ResolvedService;
	/** Container to exec in (`li-<project>-<name>`). */
	readonly container: string;
	/** Template context for catalog argv (holds secrets). */
	readonly context: TemplateContext;
	/** Every secret value of the stack, for masking tool output. */
	readonly secretValues: readonly string[];
}

/**
 * What {@link loadRunningService} checks and says.
 *
 * @typeParam T - What the precondition extracts.
 */
export interface RunningServiceCheck<T> {
	/**
	 * Checks the definition and entry before touching Docker (e.g. "has a
	 * `data` block"); an error stops the load.
	 */
	readonly precondition: (
		definition: ServiceDefinition,
		entry: StackServiceEntry,
		stack: Stack,
	) => Result<T>;
	/** Tail of the `SERVICE_NOT_RUNNING` message, e.g. `Start it to run queries.` */
	readonly startHint: string;
}

/**
 * Loads a registered project's service, runs the caller's precondition,
 * checks that its container is running (`SERVICE_NOT_RUNNING` "<name> is
 * not running. <hint>" otherwise; `DOCKER_UNREACHABLE` when inspect
 * rejects), then resolves the project read-only for its template context
 * (other services that were never started do not get in the way).
 *
 * @param deps - Project view and inspector.
 * @param ref - Project and service.
 * @param check - Precondition and message.
 * @returns The running service, or the first error.
 */
export async function loadRunningService<T>(
	deps: RunningServiceDeps,
	ref: ServiceRef,
	check: RunningServiceCheck<T>,
): Promise<Result<RunningService<T>>> {
	const loaded = await loadProject(deps, ref);
	if (!loaded.ok) return loaded;
	const stack = loaded.value;
	const entry = findService(stack, ref.name);
	if (!entry.ok) return entry;
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;
	const definition = findDefinition(definitions.value, entry.value.type);
	if (!definition.ok) return definition;
	const checked = check.precondition(definition.value, entry.value, stack);
	if (!checked.ok) return checked;

	const running = await checkRunning(
		deps.inspector,
		stack,
		ref.name,
		check.startHint,
	);
	if (!running.ok) return running;

	// Placeholders only stand in for services never started; this one runs,
	// so its own ports and secrets are real.
	const view = await readProjectView(deps, stack, "placeholder");
	if (!view.ok) return view;
	const service = view.value.resolved.services.find((s) => s.name === ref.name);
	if (service === undefined) {
		return err(
			new OpError(
				"SERVICE_NOT_FOUND",
				`Project "${stack.name}" has no service "${ref.name}"`,
				{
					details: { project: stack.name, service: ref.name },
				},
			),
		);
	}
	return ok({
		checked: checked.value,
		stack,
		entry: entry.value,
		definition: definition.value,
		resolved: view.value.resolved,
		service,
		container: running.value,
		context: serviceTemplateContext(view.value.resolved, service),
		secretValues: Object.values(collectStackSecrets(view.value.resolved)),
	});
}

async function checkRunning(
	inspector: ContainerInspector,
	stack: Stack,
	name: string,
	startHint: string,
): Promise<Result<string>> {
	const container = serviceContainerName(stack.name, name);
	let state: string | undefined;
	try {
		state = (await inspector.inspect(container))?.state;
	} catch (cause) {
		return err(dockerUnreachable(cause));
	}
	if (state === "running") return ok(container);
	return err(
		new OpError("SERVICE_NOT_RUNNING", `${name} is not running. ${startHint}`, {
			details: {
				project: stack.name,
				service: name,
				...(state !== undefined && { state }),
				fix: `Start ${name} first.`,
			},
		}),
	);
}

/**
 * @param cause - What a Docker port threw.
 * @returns The cause when it is an {@link OpError}, else `DOCKER_UNREACHABLE`.
 */
export function dockerUnreachable(cause: unknown): OpError {
	if (isOpError(cause)) return cause;
	return new OpError("DOCKER_UNREACHABLE", "Could not reach Docker", {
		cause,
		details: {
			fix: "Start Docker Desktop (or the Docker daemon) and try again.",
		},
	});
}

/** Longest tool error excerpt put in a message, in characters. */
export const TOOL_ERROR_MAX_CHARS = 500;

/** Most tool error lines put in a message. */
export const TOOL_ERROR_MAX_LINES = 3;

/**
 * The first non-empty lines of a tool's error output with every secret value
 * masked, capped at {@link TOOL_ERROR_MAX_LINES} lines and
 * {@link TOOL_ERROR_MAX_CHARS} characters.
 *
 * @param text - stderr (or stdout) of the tool.
 * @param secrets - Secret values to mask.
 * @returns The excerpt (may be empty).
 */
export function toolErrorExcerpt(
	text: string,
	secrets: readonly string[],
): string {
	const lines = maskSecrets(text, secrets, MASKED_SECRET)
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "")
		.slice(0, TOOL_ERROR_MAX_LINES);
	const excerpt = lines.join("\n");
	return excerpt.length > TOOL_ERROR_MAX_CHARS
		? `${excerpt.slice(0, TOOL_ERROR_MAX_CHARS - 1)}…`
		: excerpt;
}

/** How {@link execFailure} describes what ran. */
export interface ExecFailureContext {
	/** Secret values to mask. */
	readonly secrets: readonly string[];
	/** What ran, e.g. `Query` or `Seeding`, for the fallback messages. */
	readonly what: string;
	/** The deadline that applied, in milliseconds. */
	readonly timeoutMs: number;
	/** Fix hint of a timeout. */
	readonly timeoutFix: string;
	/** Error text already extracted (e.g. a redis `ERROR` reply). */
	readonly message?: string;
}

/**
 * Turns a failed or timed-out exec into a secret-free `INVALID_INPUT`: a
 * timeout says so; a non-zero exit carries the tool's first error lines
 * (the extracted message, else stderr, else stdout), secrets masked.
 * `details.exitCode` and `details.timedOut` are set.
 *
 * @param result - The exec result.
 * @param context - Secrets, labels and deadline.
 * @returns The error.
 */
export function execFailure(
	result: ExecResult,
	context: ExecFailureContext,
): OpError {
	const details = { exitCode: result.exitCode, timedOut: result.timedOut };
	if (result.timedOut) {
		return new OpError(
			"INVALID_INPUT",
			`${context.what} timed out after ${Math.round(context.timeoutMs / 1000)} s.`,
			{ details: { ...details, fix: context.timeoutFix } },
		);
	}
	const excerpt =
		context.message !== undefined
			? toolErrorExcerpt(context.message, context.secrets)
			: toolErrorExcerpt(result.stderr, context.secrets) ||
				toolErrorExcerpt(result.stdout, context.secrets);
	return new OpError(
		"INVALID_INPUT",
		excerpt || `${context.what} failed with exit code ${result.exitCode}.`,
		{ details },
	);
}
