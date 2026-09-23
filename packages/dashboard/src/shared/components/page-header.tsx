import type { ReactNode } from "react";

/** Props of {@link PageHeader}. */
export interface PageHeaderProps {
	readonly title: ReactNode;
	readonly subtitle?: ReactNode;
	readonly actions?: ReactNode;
}

/** 22px/600 page title, 13px muted subtitle, right-aligned actions. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
	return (
		<div className="flex flex-wrap items-end gap-2.5">
			<div className="min-w-[220px] flex-1">
				<h1 className="m-0 font-semibold text-[22px] tracking-[-0.02em]">
					{title}
				</h1>
				{subtitle ? (
					<p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
				) : null}
			</div>
			{actions}
		</div>
	);
}
