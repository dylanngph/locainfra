import { Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Application shell: shadcn sidebar block wrapped around the active route. */
export function RootLayout() {
	return (
		<TooltipProvider>
			<SidebarProvider>
				<AppSidebar variant="inset" />
				<SidebarInset>
					<SiteHeader />
					<main className="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6">
						<Outlet />
					</main>
				</SidebarInset>
			</SidebarProvider>
			<Toaster />
		</TooltipProvider>
	);
}
