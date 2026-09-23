import type { ServiceDetail } from "@locainfra/server";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { seedLabel } from "@/features/config/lib/seed-path";
import { useNow } from "@/shared/hooks/use-now";
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
import { Field, FieldError } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Skeleton } from "@/shared/ui/skeleton";
import { type Snapshot, snapshotsQuery } from "../api/snapshots.api";
import { useSnapshotActions } from "../hooks/use-snapshot-actions";
import {
	formatAgo,
	formatSize,
	validateSnapshotName,
} from "../lib/snapshot-format";
import { noSnapshotCopy, type SnapshotVolume } from "../lib/snapshot-volume";

/** Props of {@link SnapshotsTab}. */
export interface SnapshotsTabProps {
	readonly project: string;
	readonly service: ServiceDetail;
	/** Whether the service has one data volume to snapshot (`snapshotVolumeOf`). */
	readonly volume: SnapshotVolume;
	/**
	 * The entry's seed file when its definition supports seeding; shows the
	 * "Seed from ./<seed>" button.
	 */
	readonly seed?: string;
}

type Pending =
	| { readonly kind: "restore"; readonly snapshot: Snapshot }
	| { readonly kind: "delete"; readonly snapshot: Snapshot };

/**
 * Snapshots tab: name + "Create snapshot" (+ "Seed from ./<seed>"), then the
 * service's snapshots with Restore and Delete, each confirmed first. The list
 * loads once; it is refetched when an action settles.
 */
export function SnapshotsTab({
	project,
	service,
	volume,
	seed,
}: SnapshotsTabProps) {
	const actions = useSnapshotActions(project, service.name);
	const [busy, setBusy] = useState(false);
	const [pending, setPending] = useState<Pending | null>(null);
	const act = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		try {
			return await fn();
		} finally {
			setBusy(false);
		}
	};

	const form = useForm({
		defaultValues: { name: "" },
		onSubmit: async ({ value, formApi }) => {
			const name = value.name.trim();
			// Clear right away: the toast carries the name from here on.
			formApi.reset();
			await act(() => actions.create(name));
		},
	});
	const isSubmitting = useStore(form.store, (s) => s.isSubmitting);

	const seedButton =
		seed !== undefined ? (
			<Button
				type="button"
				variant="outline"
				className="h-8 rounded-control px-3"
				disabled={busy}
				onClick={() => void act(() => actions.seed(seed))}
			>
				Seed from {seedLabel(seed)}
			</Button>
		) : null;

	if (volume !== "ok") {
		return (
			<>
				{seedButton ? <div className="flex gap-2">{seedButton}</div> : null}
				<div className="rounded-card border p-7 text-center text-[13px] text-muted-foreground">
					{noSnapshotCopy(service.name, volume)}
				</div>
			</>
		);
	}

	return (
		<>
			<form
				aria-label="Create snapshot"
				onSubmit={(e) => {
					e.preventDefault();
					void form.handleSubmit();
				}}
				className="flex flex-wrap items-start gap-2"
			>
				<form.Field
					name="name"
					validators={{ onChange: ({ value }) => validateSnapshotName(value) }}
				>
					{(field) => {
						const error = firstError(field.state.meta.errors);
						return (
							<Field
								data-invalid={Boolean(error)}
								className="min-w-[220px] flex-1 gap-1"
							>
								<Input
									aria-label="Snapshot name"
									value={field.state.value}
									placeholder="snapshot name, e.g. before-migration"
									aria-invalid={Boolean(error)}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									className="h-8 rounded-control text-[13px]"
								/>
								{error ? (
									<FieldError className="text-[12px]">{error}</FieldError>
								) : null}
							</Field>
						);
					}}
				</form.Field>
				<form.Subscribe selector={(s) => s.canSubmit}>
					{(canSubmit) => (
						<Button
							type="submit"
							className="h-8 rounded-control px-3"
							disabled={busy || isSubmitting || !canSubmit}
						>
							Create snapshot
						</Button>
					)}
				</form.Subscribe>
				{seedButton}
			</form>
			<SnapshotList
				project={project}
				service={service.name}
				disabled={busy}
				onRestore={(snapshot) => setPending({ kind: "restore", snapshot })}
				onDelete={(snapshot) => setPending({ kind: "delete", snapshot })}
			/>
			<ConfirmSnapshotDialog
				service={service.name}
				pending={pending}
				onClose={() => setPending(null)}
				onConfirm={(p) => {
					setPending(null);
					void act(() =>
						p.kind === "restore"
							? actions.restore(p.snapshot)
							: actions.remove(p.snapshot),
					);
				}}
			/>
		</>
	);
}

interface SnapshotListProps {
	readonly project: string;
	readonly service: string;
	readonly disabled: boolean;
	readonly onRestore: (snapshot: Snapshot) => void;
	readonly onDelete: (snapshot: Snapshot) => void;
}

function SnapshotList({
	project,
	service,
	disabled,
	onRestore,
	onDelete,
}: SnapshotListProps) {
	const { data, isPending, isError, error } = useQuery(
		snapshotsQuery(project, service),
	);
	const now = useNow();
	if (isPending) return <Skeleton className="h-24 rounded-card" />;
	if (isError) {
		return (
			<div
				role="alert"
				className="rounded-card border p-4 text-[13px] text-muted-foreground"
			>
				{errorMessage(error)}
			</div>
		);
	}
	return (
		<ul aria-label="Snapshots" className="overflow-hidden rounded-card border">
			{data.length === 0 ? (
				<li className="p-7 text-center text-[13px] text-muted-foreground">
					No snapshots yet. Snapshots copy this service's volume so you can roll
					back data.
				</li>
			) : (
				data.map((snapshot) => (
					<li
						key={snapshot.id}
						className="flex items-center gap-3 border-hairline border-t px-4 py-3 first:border-t-0"
					>
						<div className="min-w-0 flex-1">
							<div className="truncate font-medium text-[13px]">
								{snapshot.name}
							</div>
							<div className="text-[12px] text-muted-foreground">
								{formatSize(snapshot.sizeBytes)}, created{" "}
								<time dateTime={snapshot.createdAt} title={snapshot.createdAt}>
									{formatAgo(snapshot.createdAt, now)}
								</time>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							className="h-7 rounded-control px-2.5 text-[12px]"
							disabled={disabled}
							aria-label={`Restore ${snapshot.name}`}
							onClick={() => onRestore(snapshot)}
						>
							Restore
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="h-7 rounded-control px-2.5 text-[12px] text-muted-foreground"
							disabled={disabled}
							aria-label={`Delete ${snapshot.name}`}
							onClick={() => onDelete(snapshot)}
						>
							Delete
						</Button>
					</li>
				))
			)}
		</ul>
	);
}

interface ConfirmSnapshotDialogProps {
	readonly service: string;
	readonly pending: Pending | null;
	readonly onClose: () => void;
	readonly onConfirm: (pending: Pending) => void;
}

function ConfirmSnapshotDialog({
	service,
	pending,
	onClose,
	onConfirm,
}: ConfirmSnapshotDialogProps) {
	const now = useNow();
	const restore = pending?.kind === "restore";
	const snapshot = pending?.snapshot;
	return (
		<AlertDialog
			open={pending !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<AlertDialogContent className="sm:max-w-md">
				{pending && snapshot ? (
					<>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{restore
									? `Restore “${snapshot.name}”?`
									: `Delete “${snapshot.name}”?`}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{restore
									? `This stops ${service} and replaces its data with the snapshot from ${formatAgo(snapshot.createdAt, now)}. Anything written since is lost; create a snapshot first to keep it. ${service} starts again afterwards.`
									: `The ${formatSize(snapshot.sizeBytes)} archive is deleted from disk. ${service} and its data are not touched. This can't be undone.`}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel className="h-8 rounded-control px-3">
								Cancel
							</AlertDialogCancel>
							<Button
								variant="destructive"
								className="h-8 rounded-control px-3"
								onClick={() => onConfirm(pending)}
							>
								{restore ? "Restore snapshot" : "Delete snapshot"}
							</Button>
						</AlertDialogFooter>
					</>
				) : null}
			</AlertDialogContent>
		</AlertDialog>
	);
}
