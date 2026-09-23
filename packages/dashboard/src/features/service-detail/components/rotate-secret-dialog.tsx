import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { invalidationFor } from "@/features/projects/api/project-invalidation";
import { rotateSecret } from "@/features/services/api/services.api";
import { validateRemoveConfirmation } from "@/features/services/components/remove-service-dialog";
import { ApiRequestError, errorMessage } from "@/shared/lib/api-error";
import { firstError } from "@/shared/lib/form-errors";
import { trackOp } from "@/shared/lib/track-op";
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
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";

/** Default guard text (the server's `details.fix` replaces it when present). */
export const BAKED_SECRET_FIX =
	"The password is stored in the data volume on first start; rotating it needs the volume wiped. Take a snapshot first, then rotate with Wipe volume.";

/** The secret a {@link RotateSecretDialog} asks about. */
export interface RotateTarget {
	/** Catalog secret name, e.g. `POSTGRES_PASSWORD`. */
	readonly key: string;
	/** The catalog marks it `bakedIntoVolume` and the service has a volume. */
	readonly baked: boolean;
}

/** Props of {@link RotateSecretDialog}. */
export interface RotateSecretDialogProps {
	readonly project: string;
	readonly service: string;
	/** Secret to rotate; `null` keeps the dialog closed. */
	readonly target: RotateTarget | null;
	readonly onClose: () => void;
	/** "Take a snapshot first": leave for the Snapshots tab. */
	readonly onSnapshotFirst?: () => void;
}

function RotateSecretForm({
	project,
	service,
	target,
	onClose,
	onSnapshotFirst,
}: RotateSecretDialogProps & { readonly target: RotateTarget }) {
	const queryClient = useQueryClient();
	const inputId = useId();
	// Guarded from the start when the catalog says so; the server's 422 with
	// details.fix switches a plain rotation into this mode too.
	const [guard, setGuard] = useState<string | null>(
		target.baked ? BAKED_SECRET_FIX : null,
	);
	const [submitError, setSubmitError] = useState<string>();
	const form = useForm({
		defaultValues: { confirm: "" },
		onSubmit: async () => {
			setSubmitError(undefined);
			const wipe = guard !== null;
			try {
				const opId = await rotateSecret(project, service, target.key, wipe);
				onClose();
				void trackOp(opId, {
					title: wipe
						? `Wiping ${service} and rotating ${target.key}…`
						: `Rotating ${target.key} of ${service}…`,
					queryClient,
					invalidate: invalidationFor({
						kind: "service-config",
						project,
						service,
					}),
				});
			} catch (error) {
				const fix =
					error instanceof ApiRequestError &&
					error.status === 422 &&
					typeof error.details.fix === "string"
						? error.details.fix
						: undefined;
				if (fix && !wipe) setGuard(fix);
				else setSubmitError(errorMessage(error));
			}
		},
	});
	const [typed, isSubmitting] = useStore(form.store, (s) => [
		s.values.confirm,
		s.isSubmitting,
	]);
	const matches = typed === service;

	return (
		<form
			aria-label={`Rotate ${target.key}`}
			onSubmit={(e) => {
				e.preventDefault();
				if (guard === null || matches) void form.handleSubmit();
			}}
			className="grid gap-4"
		>
			<AlertDialogHeader>
				<AlertDialogTitle>
					{guard === null
						? `Rotate ${target.key}?`
						: `${target.key} is stored in the data volume`}
				</AlertDialogTitle>
				<AlertDialogDescription>
					{guard === null ? (
						<>
							A new value is generated and <b>{service}</b> is recreated. Apps
							using the old value need the new one: copy the connection string
							again or rewrite your .env.
						</>
					) : (
						<>
							{guard} Wiping deletes every row, key and file in <b>{service}</b>
							&apos;s volume.
						</>
					)}
				</AlertDialogDescription>
			</AlertDialogHeader>
			{guard !== null && onSnapshotFirst ? (
				<Button
					type="button"
					variant="link"
					className="-mt-2 h-auto justify-self-start p-0 text-[13px]"
					onClick={() => {
						onClose();
						onSnapshotFirst();
					}}
				>
					Take a snapshot first →
				</Button>
			) : null}
			{guard !== null ? (
				<form.Field
					name="confirm"
					validators={{
						onSubmit: ({ value }) => validateRemoveConfirmation(value, service),
					}}
				>
					{(field) => {
						const error = firstError(field.state.meta.errors);
						return (
							<Field data-invalid={Boolean(error)} className="gap-1.5">
								<FieldLabel htmlFor={inputId} className="text-[13px]">
									Type <code className="font-mono">{service}</code> to confirm
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
				{guard === null ? (
					<Button
						type="submit"
						className="h-8 rounded-control px-3"
						disabled={isSubmitting}
					>
						Rotate secret
					</Button>
				) : (
					<Button
						type="submit"
						variant="destructive"
						className="h-8 rounded-control px-3"
						disabled={!matches || isSubmitting}
					>
						Wipe data and rotate
					</Button>
				)}
			</AlertDialogFooter>
		</form>
	);
}

/**
 * Rotate secret confirmation (Connect tab). A plain rotation is one click
 * (`PATCH …/secrets/:key/rotate {}`); a secret baked into the data volume
 * (catalog `secretOptions.<key>.bakedIntoVolume`, or the server's `422` with
 * `details.fix`) needs the service name typed and sends
 * `{ force: true, wipeVolume: true }` ("Wipe data and rotate"). Progress
 * follows in a toast.
 */
export function RotateSecretDialog(props: RotateSecretDialogProps) {
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
					<RotateSecretForm key={target.key} {...props} target={target} />
				) : null}
			</AlertDialogContent>
		</AlertDialog>
	);
}
