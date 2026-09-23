import { useEffect } from "react";
import { create } from "zustand";

/** Open state of the ⌘K command palette. */
export interface CommandPaletteStore {
	readonly open: boolean;
	setOpen(open: boolean): void;
	toggle(): void;
}

/** The command palette's open state (header search, Quick add, ⌘K). */
export const useCommandPaletteStore = create<CommandPaletteStore>()((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
	toggle: () => set((s) => ({ open: !s.open })),
}));

/** Opens the command palette (header search button, Catalog "Quick add"). */
export const openCommandPalette = (): void =>
	useCommandPaletteStore.getState().setOpen(true);

/**
 * Whether a keydown is the palette shortcut (⌘K on macOS, Ctrl+K elsewhere).
 *
 * @param event - Keyboard event.
 * @returns `true` for ⌘K / Ctrl+K.
 */
export const isPaletteShortcut = (event: KeyboardEvent): boolean =>
	(event.metaKey || event.ctrlKey) &&
	!event.altKey &&
	!event.shiftKey &&
	event.key.toLowerCase() === "k";

/** Toggles the palette on ⌘K / Ctrl+K anywhere in the app. */
export function usePaletteShortcut(): void {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!isPaletteShortcut(event)) return;
			event.preventDefault();
			useCommandPaletteStore.getState().toggle();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
