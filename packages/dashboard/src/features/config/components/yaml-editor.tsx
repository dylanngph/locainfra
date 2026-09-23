/** Props of {@link YamlEditor}. */
export interface YamlEditorProps {
	readonly value: string;
	readonly error: string | null;
	readonly onChange: (text: string) => void;
}

/** Dark `locainfra.yaml` side editor; edits flow back into the form. */
export function YamlEditor({ value, error, onChange }: YamlEditorProps) {
	return (
		<div className="flex flex-col overflow-hidden rounded-card border border-[#262626] bg-[#0a0a0a]">
			<div className="flex items-center border-[#262626] border-b px-3 py-2 font-mono text-[#a3a3a3] text-[12px]">
				<span className="flex-1">locainfra.yaml</span>
				<span className="font-sans text-[11px]">edits sync both ways</span>
			</div>
			<textarea
				aria-label="locainfra.yaml entry"
				value={value}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				className="min-h-[340px] resize-y border-0 bg-[#0a0a0a] px-3.5 py-3 font-mono text-[#e5e5e5] text-[12.5px] leading-[1.7] outline-none"
			/>
			{error ? (
				<div
					role="alert"
					className="border-[#262626] border-t px-3 py-2 font-mono text-[#fca5a5] text-[11.5px]"
				>
					{error}
				</div>
			) : null}
		</div>
	);
}
