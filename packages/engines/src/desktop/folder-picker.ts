import { existsSync } from "node:fs";
import type { FolderPicker, FolderPickOptions } from "@locainfra/core";
import {
	BunCommandRunner,
	type CommandRunner,
	runToCompletion,
} from "../process/command-runner";

/** Options for {@link NativeFolderPicker}. */
export interface NativeFolderPickerOptions {
	/** Spawns the dialog process (default `Bun.spawn`). */
	readonly runner?: CommandRunner;
	/** Platform (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
	/** Finds an executable on `PATH` (default `Bun.which`). */
	readonly which?: (command: string) => string | null;
	/** Whether a folder exists (default `existsSync`); a missing start folder is not passed to the dialog. */
	readonly exists?: (path: string) => boolean;
}

/**
 * Escapes text for an AppleScript double-quoted string literal.
 *
 * @param text - Raw text.
 * @returns Text safe between `"…"` in AppleScript.
 */
export function appleScriptString(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * The AppleScript run by `osascript -e` on macOS.
 *
 * @param options - Title and start folder (`defaultPath` empty to omit it).
 * @returns e.g. `POSIX path of (choose folder with prompt "Pick" default location POSIX file "/Users/me")`.
 */
export function macFolderScript(options: FolderPickOptions): string {
	const location =
		options.defaultPath === ""
			? ""
			: ` default location POSIX file "${appleScriptString(options.defaultPath)}"`;
	return `POSIX path of (choose folder with prompt "${appleScriptString(options.title)}"${location})`;
}

/**
 * Builds the dialog command for a platform, or `null` when none is available.
 *
 * @param platform - `process.platform` value.
 * @param options - Title and start folder (`defaultPath` empty to omit it).
 * @param which - Finds an executable on `PATH`.
 * @returns The argv (no shell), or `null` (Windows, or Linux without zenity/kdialog).
 */
export function folderPickerArgv(
	platform: NodeJS.Platform,
	options: FolderPickOptions,
	which: (command: string) => string | null,
): string[] | null {
	if (platform === "darwin") {
		return ["osascript", "-e", macFolderScript(options)];
	}
	if (platform === "linux" || platform === "freebsd") {
		if (which("zenity") !== null) {
			return [
				"zenity",
				"--file-selection",
				"--directory",
				`--title=${options.title}`,
				...(options.defaultPath === ""
					? []
					: [`--filename=${options.defaultPath.replace(/\/?$/, "/")}`]),
			];
		}
		if (which("kdialog") !== null) {
			return [
				"kdialog",
				"--title",
				options.title,
				"--getexistingdirectory",
				options.defaultPath === "" ? "." : options.defaultPath,
			];
		}
	}
	return null;
}

/**
 * {@link FolderPicker} showing the operating system's folder dialog on the
 * machine running the server: `osascript` on macOS, `zenity` or `kdialog` on
 * Linux, unsupported (always `null`) on Windows. Cancelling, a missing
 * dialog tool or any dialog failure resolves `null`; it never throws.
 */
export class NativeFolderPicker implements FolderPicker {
	readonly #runner: CommandRunner;
	readonly #platform: NodeJS.Platform;
	readonly #which: (command: string) => string | null;
	readonly #exists: (path: string) => boolean;

	/** @param options - Runner, platform and lookup overrides. */
	constructor(options: NativeFolderPickerOptions = {}) {
		this.#runner = options.runner ?? new BunCommandRunner();
		this.#platform = options.platform ?? process.platform;
		this.#which = options.which ?? ((command) => Bun.which(command));
		this.#exists = options.exists ?? existsSync;
	}

	/**
	 * @param options - Title and start folder.
	 * @returns The chosen absolute path (no trailing slash), or `null` when
	 *   cancelled or unsupported.
	 */
	async pick(options: FolderPickOptions): Promise<string | null> {
		const defaultPath =
			options.defaultPath !== "" && this.#exists(options.defaultPath)
				? options.defaultPath
				: "";
		const argv = folderPickerArgv(
			this.#platform,
			{ title: options.title, defaultPath },
			this.#which,
		);
		if (argv === null) return null;
		try {
			const out = await runToCompletion(this.#runner, argv);
			if (out.exitCode !== 0) return null;
			return normalizePickedPath(out.stdout);
		} catch {
			return null;
		}
	}
}

/**
 * Cleans dialog output: first line, trimmed, trailing slash removed (except `/`).
 *
 * @param stdout - Raw dialog stdout.
 * @returns An absolute path, or `null` when the output is not one.
 */
export function normalizePickedPath(stdout: string): string | null {
	const line = stdout.split(/\r?\n/)[0]?.trim() ?? "";
	if (!line.startsWith("/")) return null;
	return line.length > 1 ? line.replace(/\/+$/, "") : line;
}
