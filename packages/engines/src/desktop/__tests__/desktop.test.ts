import { describe, expect, test } from "bun:test";
import { isOpError } from "@locastack/core";
import type {
	CommandRunner,
	RunningCommand,
} from "../../process/command-runner";
import {
	browserOpenerArgv,
	escapeCmdArgument,
	SystemBrowserOpener,
} from "../browser-opener";
import {
	folderPickerArgv,
	macFolderScript,
	NativeFolderPicker,
	normalizePickedPath,
} from "../folder-picker";

function scripted(
	stdout: string,
	exitCode: number,
): CommandRunner & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		spawn(argv): RunningCommand {
			calls.push([...argv]);
			return {
				stdout: new Response(stdout).body ?? new ReadableStream(),
				stderr:
					new Response(
						exitCode === 0 ? "" : "execution error: User canceled. (-128)",
					).body ?? new ReadableStream(),
				exited: Promise.resolve(exitCode),
			};
		},
	};
}

const none = () => null;
const options = {
	title: 'Choose a folder for "shop"',
	defaultPath: "/Users/me/Dev",
};

describe("folderPickerArgv", () => {
	test("macOS uses osascript with escaped strings", () => {
		expect(folderPickerArgv("darwin", options, none)).toEqual([
			"osascript",
			"-e",
			'POSIX path of (choose folder with prompt "Choose a folder for \\"shop\\"" default location POSIX file "/Users/me/Dev")',
		]);
		expect(macFolderScript({ title: "a\\b", defaultPath: "" })).toBe(
			'POSIX path of (choose folder with prompt "a\\\\b")',
		);
	});

	test("Linux prefers zenity, then kdialog, else unsupported", () => {
		expect(
			folderPickerArgv("linux", options, (c) =>
				c === "zenity" ? "/usr/bin/zenity" : null,
			),
		).toEqual([
			"zenity",
			"--file-selection",
			"--directory",
			'--title=Choose a folder for "shop"',
			"--filename=/Users/me/Dev/",
		]);
		expect(
			folderPickerArgv("linux", options, (c) =>
				c === "kdialog" ? "/usr/bin/kdialog" : null,
			),
		).toEqual([
			"kdialog",
			"--title",
			'Choose a folder for "shop"',
			"--getexistingdirectory",
			"/Users/me/Dev",
		]);
		expect(folderPickerArgv("linux", options, none)).toBeNull();
		expect(folderPickerArgv("win32", options, () => "x")).toBeNull();
	});
});

describe("NativeFolderPicker", () => {
	test("returns the chosen folder without its trailing slash", async () => {
		const runner = scripted("/Users/me/Dev/shop-api/\n", 0);
		const picker = new NativeFolderPicker({
			runner,
			platform: "darwin",
			exists: () => true,
		});
		expect(await picker.pick(options)).toBe("/Users/me/Dev/shop-api");
		expect(runner.calls[0]?.[0]).toBe("osascript");
	});

	test("cancel resolves null; a missing start folder is not passed", async () => {
		const runner = scripted("", 1);
		const picker = new NativeFolderPicker({
			runner,
			platform: "darwin",
			exists: () => false,
		});
		expect(await picker.pick(options)).toBeNull();
		expect(runner.calls[0]?.[2]).not.toContain("default location");
	});

	test("unsupported platforms and spawn failures resolve null", async () => {
		const runner = scripted("/x\n", 0);
		expect(
			await new NativeFolderPicker({ runner, platform: "win32" }).pick(options),
		).toBeNull();
		expect(runner.calls).toEqual([]);
		const broken: CommandRunner = {
			spawn() {
				throw new Error("ENOENT");
			},
		};
		expect(
			await new NativeFolderPicker({
				runner: broken,
				platform: "darwin",
				exists: () => true,
			}).pick(options),
		).toBeNull();
	});

	test("normalizePickedPath", () => {
		expect(normalizePickedPath("/\n")).toBe("/");
		expect(normalizePickedPath("relative\n")).toBeNull();
		expect(normalizePickedPath("")).toBeNull();
	});
});

describe("SystemBrowserOpener", () => {
	const url = "http://127.0.0.1:7420/?token=abc&x=1";

	test("argv per platform", () => {
		expect(browserOpenerArgv("darwin", url)).toEqual(["open", url]);
		expect(browserOpenerArgv("linux", url)).toEqual(["xdg-open", url]);
		expect(browserOpenerArgv("win32", url)).toEqual([
			"cmd",
			"/c",
			"start",
			'""',
			"http://127.0.0.1:7420/?token=abc^&x=1",
		]);
		expect(escapeCmdArgument("a|b<c>(d)^")).toBe("a^|b^<c^>^(d^)^^");
	});

	test("opens http(s) URLs and reports a failing opener", async () => {
		const ok = scripted("", 0);
		await new SystemBrowserOpener({ runner: ok, platform: "linux" }).open(url);
		expect(ok.calls).toEqual([["xdg-open", url]]);
		const failing = scripted("", 3);
		const error = await new SystemBrowserOpener({
			runner: failing,
			platform: "linux",
		})
			.open(url)
			.catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("UNKNOWN");
	});

	test("refuses non-http URLs without spawning", async () => {
		const runner = scripted("", 0);
		const opener = new SystemBrowserOpener({ runner, platform: "darwin" });
		for (const bad of ["file:///Applications/Calculator.app", "not a url"]) {
			const error = await opener.open(bad).catch((e: unknown) => e);
			expect(isOpError(error) && error.code).toBe("INVALID_INPUT");
		}
		expect(runner.calls).toEqual([]);
	});
});
