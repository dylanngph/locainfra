import { type BrowserOpener, OpError } from "@locastack/core";
import {
	BunCommandRunner,
	type CommandRunner,
	runToCompletion,
} from "../process/command-runner";

/** Options for {@link SystemBrowserOpener}. */
export interface SystemBrowserOpenerOptions {
	/** Spawns the opener (default `Bun.spawn`). */
	readonly runner?: CommandRunner;
	/** Platform (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
}

/**
 * Escapes `cmd.exe` metacharacters with `^` so a URL survives `cmd /c start`.
 *
 * @param text - Raw argument.
 * @returns The escaped argument.
 */
export function escapeCmdArgument(text: string): string {
	return text.replace(/[\^&|<>()%!]/g, "^$&");
}

/**
 * The argv opening `url` in the default browser.
 *
 * @param platform - `process.platform` value.
 * @param url - An `http:` or `https:` URL.
 * @returns `open <url>` (macOS), `cmd /c start "" <url>` (Windows) or `xdg-open <url>` (others).
 */
export function browserOpenerArgv(
	platform: NodeJS.Platform,
	url: string,
): string[] {
	if (platform === "darwin") return ["open", url];
	if (platform === "win32") {
		return ["cmd", "/c", "start", '""', escapeCmdArgument(url)];
	}
	return ["xdg-open", url];
}

/**
 * {@link BrowserOpener} using the platform's URL handler. Only `http:` and
 * `https:` URLs are accepted, so a crafted value can never launch a local
 * file or application.
 */
export class SystemBrowserOpener implements BrowserOpener {
	readonly #runner: CommandRunner;
	readonly #platform: NodeJS.Platform;

	/** @param options - Runner and platform overrides. */
	constructor(options: SystemBrowserOpenerOptions = {}) {
		this.#runner = options.runner ?? new BunCommandRunner();
		this.#platform = options.platform ?? process.platform;
	}

	/**
	 * @param url - URL to open (the dashboard, with its session token; never logged).
	 * @throws {OpError} `INVALID_INPUT` for a non-http(s) URL; `UNKNOWN` when
	 *   the opener is missing or exits non-zero.
	 */
	async open(url: string): Promise<void> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new OpError("INVALID_INPUT", "Not a valid URL");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new OpError("INVALID_INPUT", "Only http(s) URLs can be opened", {
				details: { protocol: parsed.protocol },
			});
		}
		const argv = browserOpenerArgv(this.#platform, parsed.href);
		const opener = argv[0] ?? "";
		let exitCode: number;
		try {
			exitCode = (await runToCompletion(this.#runner, argv)).exitCode;
		} catch (cause) {
			throw new OpError("UNKNOWN", `Could not start ${opener}`, {
				details: { opener },
				cause,
			});
		}
		if (exitCode !== 0) {
			throw new OpError("UNKNOWN", `${opener} exited with code ${exitCode}`, {
				details: { opener, exitCode },
			});
		}
	}
}
