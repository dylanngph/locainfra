import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Props of {@link MetaChip}. */
export interface MetaChipProps {
	readonly icon: LucideIcon;
	readonly children: ReactNode;
	/** Native tooltip (e.g. why a figure is missing). */
	readonly title?: string;
}

/** Grey mono chip with a small icon (CPU/MEM, image, port, uptime). */
export function MetaChip({ icon: Icon, children, title }: MetaChipProps) {
	return (
		<span
			title={title}
			className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-[5px] border bg-subtle px-[7px] font-mono text-[#404040] text-[11.5px]"
		>
			<Icon aria-hidden className="size-3 opacity-60" />
			{children}
		</span>
	);
}
