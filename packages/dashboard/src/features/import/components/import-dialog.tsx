import type { ServiceDefinition } from "@locastack/server";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, FileUpIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { catalogQuery } from "@/features/catalog/api/catalog.queries";
import { pickFolder } from "@/features/projects/api/projects.api";
import { PROJECTS_KEY } from "@/features/projects/api/projects.queries";
import { validateProjectRoot } from "@/features/projects/components/new-project-card";
import { suggestedRoot } from "@/features/projects/lib/project-health";
import { BrandChip } from "@/shared/components/brand-chip";
import { ApiRequestError, errorMessage } from "@/shared/lib/api-error";
import {
	firstError,
	withoutServerError,
	withServerError,
} from "@/shared/lib/form-errors";
import { pluralize } from "@/shared/lib/format";
import { trackOp } from "@/shared/lib/track-op";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { Textarea } from "@/shared/ui/textarea";
import {
	type ImportItem,
	type ImportPreview,
	importProject,
	previewImport,
	waitForProject,
} from "../api/import.api";
import {
	IMPORT_MAX_BYTES,
	importLabel,
	includedItems,
	itemNote,
	itemPortText,
	itemTarget,
	nameFromFileName,
	PASTED_FILE_NAME,
	SAMPLE_COMPOSE,
	validateImportName,
} from "../lib/import-plan";

/** Props of {@link ImportDialog}. */
export interface ImportDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** Registered project names (name uniqueness). */
	readonly takenNames: readonly string[];
	/** Registered project folders (default folder suggestion). */
	readonly roots: readonly string[];
}

interface Parsed {
	readonly fileName: string;
	readonly preview: ImportPreview;
}

/**
 * "Import docker-compose.yml" modal (Projects page). Step 1: drop, choose or
 * paste a compose file (read in the browser) → `POST /api/import/preview`.
 * Step 2: name, folder, the services to include, "Start services after
 * import" → `POST /api/import`; progress follows in a toast and the new
 * project opens once it is registered.
 */
export function ImportDialog({
	open,
	onOpenChange,
	takenNames,
	roots,
}: ImportDialogProps) {
	const [parsed, setParsed] = useState<Parsed | null>(null);
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const setOpen = (next: boolean) => {
		if (!next) setParsed(null);
		onOpenChange(next);
	};

	/** Runs after the `202`: this component stays mounted while the page does. */
	const follow = async (name: string, opId: string) => {
		const settled = trackOp(opId, {
			title: `Importing ${name}…`,
			queryClient,
			invalidate: [{ queryKey: [...PROJECTS_KEY, "list"], exact: true }],
		});
		try {
			if (!(await waitForProject(name, opId, settled))) return;
			await queryClient.invalidateQueries({
				queryKey: [...PROJECTS_KEY, "list"],
				exact: true,
			});
			navigate(`/p/${name}`);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[680px]">
				<DialogHeader className="gap-0.5 border-b px-5 pt-[18px] pb-3.5">
					<DialogTitle className="font-semibold text-[16px] tracking-[-0.01em]">
						Import docker-compose.yml
					</DialogTitle>
					<DialogDescription className="text-[13px]">
						LocaStack turns the databases, caches and storage in your compose
						file into managed services.
					</DialogDescription>
				</DialogHeader>
				{parsed ? (
					<PreviewStep
						key={parsed.fileName + parsed.preview.suggestedName}
						parsed={parsed}
						takenNames={takenNames}
						roots={roots}
						onBack={() => setParsed(null)}
						onCancel={() => setOpen(false)}
						onAccepted={(name, opId) => {
							setOpen(false);
							void follow(name, opId);
						}}
					/>
				) : (
					<PickStep onParsed={setParsed} onCancel={() => setOpen(false)} />
				)}
			</DialogContent>
		</Dialog>
	);
}

interface PickStepProps {
	readonly onParsed: (parsed: Parsed) => void;
	readonly onCancel: () => void;
}

function PickStep({ onParsed, onCancel }: PickStepProps) {
	const fileRef = useRef<HTMLInputElement>(null);
	const [drag, setDrag] = useState(false);
	const [error, setError] = useState<string>();
	const [reading, setReading] = useState(false);

	const read = async (text: string, fileName: string) => {
		setError(undefined);
		if (!text.trim()) {
			setError("The file is empty.");
			return;
		}
		if (new TextEncoder().encode(text).length > IMPORT_MAX_BYTES) {
			setError("The file is larger than 512 KB.");
			return;
		}
		setReading(true);
		try {
			const preview = await previewImport(text, nameFromFileName(fileName));
			onParsed({ fileName, preview });
		} catch (e) {
			setError(errorMessage(e));
			setReading(false);
		}
	};
	const readFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			await read(await file.text(), file.name);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const form = useForm({
		defaultValues: { yaml: "" },
		onSubmit: ({ value }) => read(value.yaml, PASTED_FILE_NAME),
	});
	const text = useStore(form.store, (s) => s.values.yaml);

	return (
		<form
			aria-label="Choose a compose file"
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
		>
			<div className="flex flex-col gap-3.5 px-5 py-[18px]">
				<section
					aria-label="Drop zone"
					onDragOver={(e) => {
						e.preventDefault();
						setDrag(true);
					}}
					onDragLeave={() => setDrag(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDrag(false);
						void readFile(e.dataTransfer.files[0]);
					}}
					className={cn(
						"flex flex-col items-center gap-2 rounded-card border-[1.5px] border-dashed px-5 py-7 text-center transition-colors",
						drag
							? "border-[#a3a3a3] bg-muted"
							: "border-[#d4d4d4] bg-background",
					)}
				>
					<FileUpIcon aria-hidden className="size-6 opacity-60" />
					<div className="font-medium text-[14px]">
						Drop your compose file here
					</div>
					<div className="text-[12px] text-muted-foreground">
						docker-compose.yml, compose.yaml
					</div>
					<div className="mt-1.5 flex gap-2">
						<Button
							type="button"
							className="h-8 rounded-control px-3"
							disabled={reading}
							onClick={() => fileRef.current?.click()}
						>
							Choose file
						</Button>
						<Button
							type="button"
							variant="outline"
							className="h-8 rounded-control px-3"
							disabled={reading}
							onClick={() => void read(SAMPLE_COMPOSE, "docker-compose.yml")}
						>
							Use sample file
						</Button>
					</div>
					<input
						ref={fileRef}
						type="file"
						accept=".yml,.yaml"
						aria-label="Compose file"
						className="hidden"
						onChange={(e) => {
							void readFile(e.target.files?.[0]);
							e.target.value = "";
						}}
					/>
				</section>
				<div className="flex items-center gap-2.5 text-[#a3a3a3] text-[12px]">
					<div className="h-px flex-1 bg-border" />
					or paste YAML
					<div className="h-px flex-1 bg-border" />
				</div>
				<form.Field name="yaml">
					{(field) => (
						<Textarea
							aria-label="Compose YAML"
							spellCheck={false}
							value={field.state.value}
							placeholder={"services:\n  db:\n    image: postgres:16"}
							onChange={(e) => {
								setError(undefined);
								field.handleChange(e.target.value);
							}}
							className="min-h-[120px] resize-y rounded-lg bg-[#fcfcfc] px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] dark:bg-muted/40"
						/>
					)}
				</form.Field>
				{error ? (
					<div
						role="alert"
						className="rounded-control border border-[#FECACA] bg-[#FEF2F2] px-2.5 py-2 text-[#B91C1C] text-[13px] dark:border-red-900 dark:bg-red-950 dark:text-red-300"
					>
						{error}
					</div>
				) : null}
			</div>
			<DialogFooter className="mx-0 mb-0 rounded-none border-t bg-background px-5 py-3">
				<Button
					type="button"
					variant="outline"
					className="h-8 rounded-control px-3"
					onClick={onCancel}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					className={cn(
						"h-8 rounded-control px-3",
						!text.trim() && "opacity-45",
					)}
					aria-disabled={!text.trim()}
					disabled={reading}
				>
					{reading ? "Reading…" : "Continue"}
				</Button>
			</DialogFooter>
		</form>
	);
}

interface PreviewStepProps {
	readonly parsed: Parsed;
	readonly takenNames: readonly string[];
	readonly roots: readonly string[];
	readonly onBack: () => void;
	readonly onCancel: () => void;
	/** Called with the `202`'s op id; the dialog closes and follows it. */
	readonly onAccepted: (name: string, opId: string) => void;
}

/** Values of the Import review form. */
export interface ImportFormValues {
	name: string;
	root: string;
	start: boolean;
	items: ImportItem[];
}

function PreviewStep({
	parsed,
	takenNames,
	roots,
	onBack,
	onCancel,
	onAccepted,
}: PreviewStepProps) {
	const { data: catalog } = useQuery(catalogQuery());
	const definitions = catalog?.definitions ?? [];
	const [submitError, setSubmitError] = useState<string>();
	const form = useForm({
		defaultValues: {
			name: parsed.preview.suggestedName,
			root: "",
			start: true,
			items: parsed.preview.items,
		} as ImportFormValues,
		onSubmit: async ({ value }) => {
			setSubmitError(undefined);
			if (includedItems(value.items).length === 0) return;
			try {
				const opId = await importProject({
					name: value.name,
					root: value.root || suggestedRoot(value.name, roots),
					items: value.items,
					start: value.start,
				});
				onAccepted(value.name, opId);
			} catch (error) {
				if (
					error instanceof ApiRequestError &&
					error.code === "PROJECT_EXISTS"
				) {
					form.setFieldMeta("name", withServerError(error.message));
				} else setSubmitError(errorMessage(error));
			}
		},
	});
	const [values, isValid, isSubmitting] = useStore(form.store, (s) => [
		s.values,
		s.isValid,
		s.isSubmitting,
	]);
	const included = includedItems(values.items).length;
	const ready = isValid && included > 0;

	const toggle = (index: number) => {
		const item = values.items[index];
		if (!item?.supported) return;
		form.setFieldValue(
			"items",
			values.items.map((it, i) =>
				i === index ? { ...it, include: !it.include } : it,
			),
		);
	};
	const choose = async () => {
		try {
			const picked = await pickFolder(values.name || undefined);
			if (picked) form.setFieldValue("root", picked);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	return (
		<form
			aria-label="Review import"
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
		>
			<div className="flex flex-col gap-3.5 px-5 py-[18px]">
				<div className="flex flex-wrap items-center gap-2.5 text-[13px]">
					<FileTextIcon aria-hidden className="size-4 opacity-60" />
					<span className="font-mono text-[12.5px]">{parsed.fileName}</span>
					<span className="text-muted-foreground">
						{pluralize(values.items.length, "service")} found, {included} will
						be imported
					</span>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<form.Field
						name="name"
						validators={{
							onMount: ({ value }) => validateImportName(value, takenNames),
							onChange: ({ value }) => validateImportName(value, takenNames),
						}}
						listeners={{
							onChange: () => form.setFieldMeta("name", withoutServerError),
						}}
					>
						{(field) => {
							const error = firstError(field.state.meta.errors);
							return (
								<Field data-invalid={Boolean(error)} className="gap-1.5">
									<FieldLabel htmlFor="import-name" className="text-[13px]">
										Project name
									</FieldLabel>
									<Input
										id="import-name"
										value={field.state.value}
										aria-invalid={Boolean(error)}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										className="h-[34px] rounded-control text-[13px]"
									/>
									{error ? (
										<FieldError className="text-[12px]">{error}</FieldError>
									) : null}
								</Field>
							);
						}}
					</form.Field>
					<form.Field
						name="root"
						validators={{ onChange: ({ value }) => validateProjectRoot(value) }}
					>
						{(field) => {
							const error = firstError(field.state.meta.errors);
							return (
								<Field data-invalid={Boolean(error)} className="gap-1.5">
									<FieldLabel htmlFor="import-root" className="text-[13px]">
										Folder
									</FieldLabel>
									<div className="flex gap-2">
										<Input
											id="import-root"
											value={field.state.value}
											placeholder={suggestedRoot(values.name, roots)}
											aria-invalid={Boolean(error)}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											className="h-[34px] min-w-0 flex-1 rounded-control font-mono text-[12px]"
										/>
										<Button
											type="button"
											variant="outline"
											className="h-[34px] rounded-control text-[12px]"
											onClick={() => void choose()}
										>
											Choose…
										</Button>
									</div>
									{error ? (
										<FieldError className="text-[12px]">{error}</FieldError>
									) : null}
								</Field>
							);
						}}
					</form.Field>
				</div>
				<div className="overflow-hidden rounded-card border">
					<Table aria-label="Compose services" className="text-[13px]">
						<TableHeader className="bg-subtle">
							<TableRow className="hover:bg-transparent">
								<TableHead className="w-10 px-3.5">
									<span className="sr-only">Include</span>
								</TableHead>
								<TableHead className="h-8 font-normal text-[12px] text-muted-foreground">
									Compose service
								</TableHead>
								<TableHead className="h-8 w-[180px] font-normal text-[12px] text-muted-foreground">
									Becomes
								</TableHead>
								<TableHead className="h-8 w-[110px] font-normal text-[12px] text-muted-foreground">
									Host port
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{values.items.map((item, index) => (
								<ImportRow
									key={item.composeName}
									item={item}
									definitions={definitions}
									onToggle={() => toggle(index)}
								/>
							))}
						</TableBody>
					</Table>
				</div>
				<form.Field name="start">
					{(field) => (
						<label
							htmlFor="import-start"
							className="flex items-center gap-2.5 self-start text-[13px]"
						>
							<Switch
								id="import-start"
								checked={field.state.value}
								onCheckedChange={(checked) => field.handleChange(checked)}
							/>
							Start services after import
						</label>
					)}
				</form.Field>
				{submitError ? (
					<p role="alert" className="text-[12px] text-status-error-fg">
						{submitError}
					</p>
				) : null}
			</div>
			<DialogFooter className="mx-0 mb-0 rounded-none border-t bg-background px-5 py-3">
				<Button
					type="button"
					variant="outline"
					className="h-8 rounded-control px-3 sm:mr-auto"
					onClick={onBack}
				>
					Back
				</Button>
				<Button
					type="button"
					variant="outline"
					className="h-8 rounded-control px-3"
					onClick={onCancel}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					className={cn("h-8 rounded-control px-3", !ready && "opacity-45")}
					aria-disabled={!ready}
					disabled={isSubmitting}
				>
					{importLabel(included)}
				</Button>
			</DialogFooter>
		</form>
	);
}

interface ImportRowProps {
	readonly item: ImportItem;
	readonly definitions: readonly ServiceDefinition[];
	readonly onToggle: () => void;
}

function ImportRow({ item, definitions, onToggle }: ImportRowProps) {
	const def = definitions.find((d) => d.id === item.type);
	const note = itemNote(item);
	const dim = !(item.supported && item.include);
	return (
		<TableRow
			onClick={(e) => {
				if (!(e.target as Element).closest("[data-slot=checkbox]")) onToggle();
			}}
			className={cn(item.supported && "cursor-pointer")}
		>
			<TableCell className="px-3.5">
				<Checkbox
					aria-label={`Import ${item.composeName}`}
					checked={item.supported && item.include}
					disabled={!item.supported}
					onCheckedChange={onToggle}
				/>
			</TableCell>
			<TableCell className={cn("max-w-0", dim && "opacity-50")}>
				<div className="flex min-w-0 items-center gap-2.5">
					<BrandChip type={item.type ?? "unknown"} icon={def?.icon} size="sm" />
					<span className="min-w-0">
						<span className="block font-medium text-[13px]">
							{item.composeName}
						</span>
						<span className="block truncate font-mono text-[11.5px] text-muted-foreground">
							{item.image ?? "build: ."}
						</span>
					</span>
				</div>
			</TableCell>
			<TableCell
				className={cn("whitespace-normal text-[13px]", dim && "opacity-50")}
			>
				{itemTarget(item, definitions)}
				{note ? (
					<span className="block text-[11.5px] text-muted-foreground">
						{note}
					</span>
				) : null}
			</TableCell>
			<TableCell className={cn("font-mono text-[12.5px]", dim && "opacity-50")}>
				{itemPortText(item)}
			</TableCell>
		</TableRow>
	);
}
