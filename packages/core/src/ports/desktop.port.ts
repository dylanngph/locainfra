/** Options of {@link FolderPicker.pick}. */
export interface FolderPickOptions {
	/** Dialog title, e.g. "Choose a folder for shop-api". */
	readonly title: string;
	/** Absolute folder the dialog opens in (e.g. `~/Developer`). */
	readonly defaultPath: string;
}

/** Native folder chooser on the machine running the server (e.g. `osascript` on macOS). */
export interface FolderPicker {
	/**
	 * Shows the dialog and waits for the user.
	 *
	 * @param options - Title and start folder.
	 * @returns The chosen absolute path, or `null` when cancelled or unsupported.
	 */
	pick(options: FolderPickOptions): Promise<string | null>;
}

/** Opens a URL in the user's default browser. */
export interface BrowserOpener {
	/**
	 * @param url - URL to open (the dashboard, with its session token).
	 */
	open(url: string): Promise<void>;
}
