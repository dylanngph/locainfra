import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: OverviewPage,
});

function OverviewPage() {
	return (
		<section>
			<h1 className="font-semibold text-2xl tracking-tight">Overview</h1>
			<p className="text-muted-foreground text-sm">
				Stacks and services will appear here.
			</p>
		</section>
	);
}
