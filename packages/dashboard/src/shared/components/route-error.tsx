import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { ApiRequestError } from "@/shared/lib/api-error";
import { Button, buttonVariants } from "@/shared/ui/button";

const describe = (error: unknown): { title: string; message: string } => {
	if (isRouteErrorResponse(error)) {
		const message =
			typeof error.data === "string"
				? error.data
				: typeof error.data === "object" &&
						error.data !== null &&
						"message" in error.data &&
						typeof error.data.message === "string"
					? error.data.message
					: error.statusText;
		return {
			title: error.status === 404 ? "Not found" : `Error ${error.status}`,
			message,
		};
	}
	if (error instanceof ApiRequestError) {
		return {
			title:
				error.status === 0
					? "Cannot reach the LocaStack server"
					: "Something went wrong",
			message: error.message,
		};
	}
	if (error instanceof Error) {
		return { title: "Something went wrong", message: error.message };
	}
	return { title: "Something went wrong", message: "Unknown error" };
};

/** Route-level error boundary: explains the failure and offers a way back. */
export function RouteErrorBoundary() {
	const error = useRouteError();
	const { title, message } = describe(error);
	return (
		<div
			role="alert"
			className="mx-auto my-12 flex w-full max-w-[520px] flex-col items-center gap-2 rounded-card border border-dashed px-6 py-10 text-center"
		>
			<div className="font-semibold text-[15px]">{title}</div>
			<p className="text-[13px] text-muted-foreground">{message}</p>
			<div className="mt-2 flex gap-2">
				<Button variant="outline" onClick={() => window.location.reload()}>
					Retry
				</Button>
				<Link to="/" className={buttonVariants()}>
					All projects
				</Link>
			</div>
		</div>
	);
}
