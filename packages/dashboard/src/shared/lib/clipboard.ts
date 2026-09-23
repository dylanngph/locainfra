import { toast } from "sonner";

/**
 * Copies text to the clipboard and confirms with a toast.
 *
 * @param text - Text to copy.
 * @param message - Toast shown on success.
 * @returns Whether the copy succeeded.
 */
export async function copyText(
	text: string,
	message = "Copied to clipboard",
): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		toast(message);
		return true;
	} catch {
		toast.error("Could not access the clipboard");
		return false;
	}
}

/**
 * Starts a browser download of a text file.
 *
 * @param fileName - Suggested file name.
 * @param text - File contents.
 * @param type - MIME type (default `text/plain`).
 */
export function downloadText(
	fileName: string,
	text: string,
	type = "text/plain",
): void {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
