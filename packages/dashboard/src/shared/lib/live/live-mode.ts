import { create } from "zustand";

/** Per-project Live switch state. */
export interface LiveModeStore {
	/** Project → Live on/off for this page load (absent = off). */
	readonly projects: Readonly<Record<string, boolean>>;
	/** Turns Live on or off for a project (in memory only). */
	setLive(project: string, on: boolean): void;
	/** Forgets every choice (tests). */
	reset(): void;
}

/**
 * Live mode choices, kept in memory only: they survive in-app navigation but
 * never a reload, a bookmark or a new tab, so every fresh load starts with
 * Live off and no WebSocket until the user turns it on.
 */
export const useLiveModeStore = create<LiveModeStore>()((set) => ({
	projects: {},
	setLive: (project, on) =>
		set((state) => ({ projects: { ...state.projects, [project]: on } })),
	reset: () => set({ projects: {} }),
}));

/**
 * Whether Live mode is on for a project (opt-in, off on every fresh load).
 * While off the dashboard loads data once and never opens the observer
 * WebSocket for that project.
 *
 * @param project - Project name (empty outside a project → always off).
 * @returns Whether Live is on.
 */
export function useLiveMode(project: string): boolean {
	const on = useLiveModeStore((s) => s.projects[project] ?? false);
	return project !== "" && on;
}
