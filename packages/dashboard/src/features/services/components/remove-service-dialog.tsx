import { useForm, useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { errorMessage } from "@/shared/lib/api-error";
import { firstError } from "@/shared/lib/form-errors";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { useRemoveService } from "../hooks/use-remove-service";

/** The service a {@link RemoveServiceDialog} asks about. */
export interface RemoveTarget {
	readonly name: string;
	/** `volume` shows the "Also delete its data volume and snapshots" option. */
	readonly persist: "volume" | "ephemeral";
}

/** Props of {@link RemoveServiceDialog}. */
export interface RemoveServiceDialogProps {
	readonly project: string;
	/** Service to remove; `null` keeps the dialog closed. */
	readonly target: RemoveTarget | null;
	/** Called to close the dialog (Cancel, Esc, after removing). */
	readonly onClose: () => void;
	/** Called once the server accepted the removal (e.g. leave the detail page). */
	readonly onRemoved?: (name: string) => void;
}

/** Values of the remove confirmation form. */
export interface RemoveServiceValues {
	confirm: string;
	volumes: boolean;
}

/**
 * Validates the typed confirmation.
 *
 * @param typed - What the user typed.
 * @param name - Service name to match exactly.
 * @returns An error message, or `undefined` when it matches.
 */
export function validateRemoveConfirmation(
	typed: string,
	name: string,
): string | undefined {
	return typed === name ? undefined : `Type ${name} to confirm.`;
}

function RemoveServiceForm({
	project,
	target,
	onClose,
	onRemoved,
}: RemoveServiceDialogProps & { readonly target: RemoveTarget }) {
	const remove = useRemoveService(project);
	const inputId = useId();
	const volumesLabelId = useId();
	const [submitError, setSubmitError] = useState<string>();
	const form = useForm({
		defaultValues: { confirm: "", volumes: false } as RemoveServiceValues,
		onSubmit: async ({ value }) => {
			setSubmitError(undefined);
			try {
				await remove(target.name, value.volumes);
				onClose();
				onRemoved?.(target.name);
			} catch (error) {
				setSubmitError(errorMessage(error));
			}
		},
	});
	const [typed, isSubmitting] = useStore(form.store, (s) => [
		s.values.confirm,
		s.isSubmitting,
	]);
	const matches = typed === target.name;

	return (
		<form
			aria-label={`Remove ${target.name}`}
			onSubmit={(e) => {
				e.preventDefault();
				if (matches) void form.handleSubmit();
			}}
			className="grid gap-4"
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Remove {target.name}?</AlertDialogTitle>
				<AlertDialogDescription>
					This deletes the container and removes <b>{target.name}</b> from{" "}
					<code className="font-mono">locastack.yaml</code>.
					{target.persist === "volume"
						? " Its data volume and snapshots are kept unless you also delete them."
						: " It keeps no data (ephemeral)."}
				</AlertDialogDescription>
			</AlertDialogHeader>
			<form.Field
				name="confirm"
				validators={{
					onSubmit: ({ value }) =>
						validateRemoveConfirmation(value, target.name),
				}}
			>
				{(field) => {
					const error = firstError(field.state.meta.errors);
					return (
						<Field data-invalid={Boolean(error)} className="gap-1.5">
							<FieldLabel htmlFor={inputId} className="text-[13px]">
								Type <code className="font-mono">{target.name}</code> to confirm
							</FieldLabel>
							<Input
								id={inputId}
								autoFocus
								autoComplete="off"
								spellCheck={false}
								value={field.state.value}
								aria-invalid={Boolean(error)}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								className="h-[34px] rounded-control font-mono text-[13px]"
							/>
							{error ? (
								<FieldError className="text-[12px]">{error}</FieldError>
							) : null}
						</Field>
					);
				}}
			</form.Field>
			{target.persist === "volume" ? (
				<form.Field name="volumes">
					{(field) => (
						<Field orientation="horizontal" className="items-center gap-2">
							<Checkbox
								aria-labelledby={volumesLabelId}
								checked={field.state.value}
								onCheckedChange={(checked) => field.handleChange(checked)}
							/>
							<span id={volumesLabelId} className="text-[13px]">
								Also delete its data volume and snapshots
							</span>
						</Field>
					)}
				</form.Field>
			) : null}
			{submitError ? (
				<p role="alert" className="text-[12px] text-status-error-fg">
					{submitError}
				</p>
			) : null}
			<AlertDialogFooter>
				<AlertDialogCancel className="h-8 rounded-control px-3">
					Cancel
				</AlertDialogCancel>
				<Button
					type="submit"
					variant="destructive"
					className="h-8 rounded-control px-3"
					disabled={!matches || isSubmitting}
				>
					Remove service
				</Button>
			</AlertDialogFooter>
		</form>
	);
}

/**
 * Remove service confirmation: the user types the service name exactly,
 * optionally ticks "Also delete its data volume and snapshots", and the dialog sends
 * `DELETE …/services/:name?volumes=` and follows the op in a toast.
 */
export function RemoveServiceDialog(props: RemoveServiceDialogProps) {
	const { target, onClose } = props;
	return (
		<AlertDialog
			open={target !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<AlertDialogContent className="sm:max-w-md">
				{target ? (
					<RemoveServiceForm key={target.name} {...props} target={target} />
				) : null}
			</AlertDialogContent>
		</AlertDialog>
	);
}
