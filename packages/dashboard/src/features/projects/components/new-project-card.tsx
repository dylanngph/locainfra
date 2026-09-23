import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ApiRequestError, errorMessage } from "@/shared/lib/api-error";
import {
	firstError,
	withoutServerError,
	withServerError,
} from "@/shared/lib/form-errors";
import { Button } from "@/shared/ui/button";
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { createProject, pickFolder } from "../api/projects.api";
import { PROJECTS_KEY } from "../api/projects.queries";
import { suggestedRoot } from "../lib/project-health";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Values of the New project form. */
export interface NewProjectValues {
	name: string;
	root: string;
}

/**
 * Validates a new project name.
 *
 * @param name - Proposed name.
 * @param taken - Names of registered projects.
 * @returns An error message, or `undefined` when valid.
 */
export function validateProjectName(
	name: string,
	taken: readonly string[],
): string | undefined {
	if (!name) return "Name is required.";
	if (!NAME_PATTERN.test(name))
		return "Use lowercase letters, numbers and dashes.";
	if (taken.includes(name)) return "That name is taken.";
	return undefined;
}

/** Props of {@link NewProjectCard}. */
export interface NewProjectCardProps {
	readonly takenNames: readonly string[];
	readonly roots: readonly string[];
	readonly onCancel: () => void;
}

/**
 * Validates the optional folder: empty means "use the suggestion".
 *
 * @param root - Folder typed by the user.
 * @returns An error message, or `undefined` when valid.
 */
export function validateProjectRoot(root: string): string | undefined {
	return root && !root.startsWith("/") && !root.startsWith("~/")
		? "Use an absolute folder path."
		: undefined;
}

/** Inline New project card: name + folder (native picker via the server). */
export function NewProjectCard({
	takenNames,
	roots,
	onCancel,
}: NewProjectCardProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const form = useForm({
		defaultValues: { name: "", root: "" } satisfies NewProjectValues,
		onSubmit: async ({ value }) => {
			const { name, root } = value;
			try {
				await createProject({ name, root: root || suggestedRoot(name, roots) });
				await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
				toast(`Created ${name}`);
				navigate(`/p/${name}`);
			} catch (error) {
				if (
					error instanceof ApiRequestError &&
					error.code === "PROJECT_EXISTS"
				) {
					setServerError("name", error.message);
				} else if (error instanceof ApiRequestError && error.status === 422) {
					setServerError("root", error.message);
				} else toast.error(errorMessage(error));
			}
		},
	});
	const setServerError = (field: keyof NewProjectValues, message: string) =>
		form.setFieldMeta(field, withServerError(message));
	const clearServerError = (field: keyof NewProjectValues) =>
		form.setFieldMeta(field, withoutServerError);
	const name = useStore(form.store, (s) => s.values.name);
	const [isSubmitting, isValid] = useStore(form.store, (s) => [
		s.isSubmitting,
		s.isValid,
	]);

	const choose = async () => {
		try {
			const picked = await pickFolder(name || undefined);
			if (picked) form.setFieldValue("root", picked);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	return (
		<form
			aria-label="New project"
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onCancel();
			}}
			className="flex flex-col justify-center gap-2.5 rounded-card border border-foreground p-4"
		>
			<form.Field
				name="name"
				validators={{
					onChange: ({ value }) => validateProjectName(value, takenNames),
					onSubmit: ({ value }) => validateProjectName(value, takenNames),
				}}
				listeners={{ onChange: () => clearServerError("name") }}
			>
				{(field) => {
					const error = firstError(field.state.meta.errors);
					return (
						<Field data-invalid={Boolean(error)} className="gap-1.5">
							<FieldLabel htmlFor="new-project-name" className="text-[13px]">
								Project name
							</FieldLabel>
							<Input
								id="new-project-name"
								autoFocus
								value={field.state.value}
								placeholder="my-app"
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
				listeners={{ onChange: () => clearServerError("root") }}
			>
				{(field) => {
					const error = firstError(field.state.meta.errors);
					return (
						<Field data-invalid={Boolean(error)} className="gap-1.5">
							<FieldLabel htmlFor="new-project-root" className="text-[13px]">
								Folder
							</FieldLabel>
							<div className="flex gap-2">
								<Input
									id="new-project-root"
									value={field.state.value}
									placeholder={suggestedRoot(name, roots)}
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
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-7 rounded-control text-[12px]"
					onClick={onCancel}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					className="h-7 rounded-control text-[12px]"
					disabled={isSubmitting}
					aria-disabled={!isValid}
				>
					Create
				</Button>
			</div>
		</form>
	);
}
