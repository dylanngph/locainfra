import type { SVGProps } from "react";

/** Props for the LocaStack mark. Color comes from `currentColor`. */
export interface LogoMarkProps
	extends Omit<SVGProps<SVGSVGElement>, "children"> {
	/** Rendered width and height in px. */
	size?: number;
	/** Color of the lit (larger) cell; defaults to currentColor. */
	accent?: string;
}

/**
 * The "Dominant" mark: a 2×2 field of rounded cells with one larger lit cell,
 * the local node. Drawn on a 24-unit grid so it stays crisp at 16 px.
 */
export function LogoMark({ size = 20, accent, ...rest }: LogoMarkProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			{...rest}
		>
			<rect x="2" y="2" width="7" height="7" rx="1.54" opacity=".28" />
			<rect x="11" y="2" width="7" height="7" rx="1.54" opacity=".28" />
			<rect x="2" y="11" width="7" height="7" rx="1.54" opacity=".28" />
			<rect
				x="11"
				y="11"
				width="11"
				height="11"
				rx="2.6"
				fill={accent ?? "currentColor"}
			/>
		</svg>
	);
}

/** Props for the mark + wordmark lockup. */
export interface LogoProps {
	/** Mark size in px; the wordmark scales with it. */
	size?: number;
	/** Extra classes for the wrapper. */
	className?: string;
}

/** Horizontal lockup: mark followed by "LocaStack" in Geist 600. */
export function Logo({ size = 20, className }: LogoProps) {
	const fontSize = Math.round(size * 0.75);
	return (
		<span
			className={className}
			style={{ display: "inline-flex", alignItems: "center", gap: size * 0.45 }}
		>
			<LogoMark size={size} />
			<span
				style={{
					fontWeight: 600,
					fontSize,
					lineHeight: 1,
					letterSpacing: fontSize > 24 ? "-0.03em" : "-0.02em",
				}}
			>
				LocaStack
			</span>
		</span>
	);
}
