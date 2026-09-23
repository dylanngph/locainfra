import { BoxIcon } from "lucide-react";
import { brandMark } from "@/shared/lib/icons";
import { cn } from "@/shared/lib/utils";

const SIZES = {
	sm: { box: "size-7 rounded-control", icon: 16 },
	md: { box: "size-[34px] rounded-lg", icon: 18 },
	lg: { box: "size-[38px] rounded-lg", icon: 20 },
	xl: { box: "size-10 rounded-lg", icon: 22 },
} as const;

/** Props of {@link BrandIcon}. */
export interface BrandIconProps {
	readonly type: string;
	readonly icon?: string;
	readonly size?: number;
	readonly className?: string;
}

/** A bundled brand mark in its brand color. */
export function BrandIcon({
	type,
	icon,
	size = 16,
	className,
}: BrandIconProps) {
	const mark = brandMark(type, icon);
	if (!mark.path) {
		return (
			<BoxIcon
				aria-hidden
				className={className}
				style={{ width: size, height: size, color: mark.color }}
			/>
		);
	}
	return (
		<svg
			role="img"
			aria-label={mark.title}
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill={mark.color}
		>
			<path d={mark.path} />
		</svg>
	);
}

/** Props of {@link BrandChip}. */
export interface BrandChipProps {
	readonly type: string;
	readonly icon?: string;
	readonly size?: keyof typeof SIZES;
	readonly className?: string;
}

/** Brand icon in a tinted square (brand color at 8% bg, 25% border). */
export function BrandChip({
	type,
	icon,
	size = "sm",
	className,
}: BrandChipProps) {
	const mark = brandMark(type, icon);
	const s = SIZES[size];
	return (
		<span
			className={cn(
				"box-border flex flex-none items-center justify-center border",
				s.box,
				className,
			)}
			style={{
				background: `${mark.color}14`,
				borderColor: `${mark.color}40`,
			}}
		>
			<BrandIcon type={type} icon={icon} size={s.icon} />
		</span>
	);
}

/** Props of {@link TypeChip}. */
export interface TypeChipProps {
	readonly type: string;
	readonly icon?: string;
	readonly label?: string;
}

/** Small mono chip with a brand icon (project cards). */
export function TypeChip({ type, icon, label }: TypeChipProps) {
	const mark = brandMark(type, icon);
	return (
		<span
			className="inline-flex items-center gap-[5px] rounded-[5px] border px-[7px] font-medium font-mono text-[11px] leading-5"
			style={{
				background: `${mark.color}14`,
				borderColor: `${mark.color}40`,
				color: mark.color,
			}}
		>
			<BrandIcon type={type} icon={icon} size={14} />
			{label ?? type}
		</span>
	);
}
