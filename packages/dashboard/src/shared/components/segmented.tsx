import { cn } from "@/shared/lib/utils";

/** One option of a {@link Segmented} control. */
export interface SegmentedOption<T extends string> {
	readonly value: T;
	readonly label: string;
}

/** Props of {@link Segmented}. */
export interface SegmentedProps<T extends string> {
	readonly value: T;
	readonly options: readonly SegmentedOption<T>[];
	readonly onChange: (value: T) => void;
	/** Accessible name of the group. */
	readonly label: string;
	/** Stretch options to fill the width. */
	readonly stretch?: boolean;
	readonly className?: string;
}

/** Grey segmented control with a raised white active option. */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
	stretch,
	className,
}: SegmentedProps<T>) {
	return (
		<fieldset
			className={cn(
				"m-0 inline-flex min-w-0 flex-wrap gap-0.5 rounded-lg border-0 bg-muted p-[3px]",
				stretch && "flex w-full",
				className,
			)}
		>
			<legend className="sr-only">{label}</legend>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.value)}
						className={cn(
							"h-7 rounded-control px-3 font-medium text-[13px] transition-colors",
							stretch && "h-[30px] flex-1",
							active
								? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</fieldset>
	);
}
