import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Bottom-right dark toasts (design brief §7). */
const Toaster = ({ ...props }: ToasterProps) => {
	return (
		<Sonner
			theme="dark"
			position="bottom-right"
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			style={
				{
					"--normal-bg": "#0a0a0a",
					"--normal-text": "#fafafa",
					"--normal-border": "#0a0a0a",
					"--border-radius": "8px",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: "cn-toast text-[13px]",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
