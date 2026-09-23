import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
	readonly queryClient: QueryClient;
	readonly children: ReactNode;
}

/**
 * Providers that live outside the router (the query client is shared with
 * route loaders). Router-dependent providers (nuqs) sit in the root layout.
 */
export function AppProviders({ queryClient, children }: AppProvidersProps) {
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}
