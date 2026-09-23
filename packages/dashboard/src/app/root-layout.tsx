import { NuqsAdapter } from "nuqs/adapters/react-router/v8";
import { Outlet } from "react-router";
import { CommandPalette } from "@/features/command-palette/components/command-palette";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { AppHeader } from "./header";

/** Application shell: sticky header, routed content, ⌘K palette, toasts. */
export function RootLayout() {
	return (
		<NuqsAdapter>
			<TooltipProvider>
				<div className="flex min-h-screen flex-col bg-background text-foreground">
					<AppHeader />
					<Outlet />
				</div>
				<CommandPalette />
				<Toaster />
			</TooltipProvider>
		</NuqsAdapter>
	);
}

/** Shown while the first route's loaders run. */
export function AppFallback() {
	return (
		<div className="flex min-h-screen flex-col">
			<div className="h-[52px] border-b" />
			<div className="mx-auto mt-9 h-6 w-40 animate-pulse rounded-control bg-muted" />
		</div>
	);
}
