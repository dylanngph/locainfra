import type { ReactNode } from "react";

/** Props of {@link DashedEmpty}. */
export interface DashedEmptyProps {
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly action?: ReactNode;
}

/** Dashed empty-state card (no services, no matches, M3 placeholders). */
export function DashedEmpty({ title, description, action }: DashedEmptyProps) {
	return (
		<div className="flex flex-col items-center gap-2 rounded-card border border-[#d4d4d4] border-dashed px-6 py-12 text-center">
			<div className="font-semibold">{title}</div>
			{description ? (
				<div className="max-w-[360px] text-[13px] text-muted-foreground">
					{description}
				</div>
			) : null}
			{action ? <div className="mt-1.5">{action}</div> : null}
		</div>
	);
}
