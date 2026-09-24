import type { PersistMode } from "@locastack/server";
import { useForm, useStore } from "@tanstack/react-form";
import {
	useQuery,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import {
	catalogQuery,
	freePortQuery,
} from "@/features/catalog/api/catalog.queries";
import { imageOf } from "@/features/catalog/lib/filter-catalog";
import { invalidationFor } from "@/features/projects/api/project-invalidation";
import { projectQuery } from "@/features/projects/api/projects.queries";
import {
	addService,
	waitForService,
} from "@/features/services/api/services.api";
import { BrandChip } from "@/shared/components/brand-chip";
import { Segmented } from "@/shared/components/segmented";
import { ApiRequestError, errorMessage } from "@/shared/lib/api-error";
import {
	firstError,
	withoutServerError,
	withServerError,
} from "@/shared/lib/form-errors";
import { trackOp } from "@/shared/lib/track-op";
import { cn } from "@/shared/lib/utils";
import { Button, buttonVariants } from "@/shared/ui/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/shared/ui/select";
import {
	AUTO_PORT,
	buildDefaults,
	type ConfigContext,
	configErrors,
	configLabel,
	portSuggestion,
	resolveDefault,
	secretLabel,
	toAddBody,
	toStackEntry,
	validateHostPort,
	validateInstanceName,
} from "../lib/config-form";
import { entryToYaml, yamlToEntry } from "../lib/entry-yaml";
import { generateSecret } from "../lib/secret";
import { validateSeedPath } from "../lib/seed-path";
import { YamlEditor } from "./yaml-editor";

const PERSIST_OPTIONS = [
	{ value: "volume", label: "Persistent volume" },
	{ value: "ephemeral", label: "Ephemeral" },
] as const satisfies readonly { value: PersistMode; label: string }[];

const inputClass = "h-[34px] rounded-control text-[13px]";

/** `/p/:project/add/:type`: configure a new instance, then Add & start. */
export function ConfigPage() {
	const { project = "", type = "" } = useParams();
	const { data: catalog } = useSuspenseQuery(catalogQuery());
	const { data: detail } = useSuspenseQuery(projectQuery(project));
	const { data: suggestedPort } = useQuery(freePortQuery(type));
	const definition = catalog.definitions.find((d) => d.id === type);
	if (!definition) throw new Error(`Unknown service type "${type}"`);
	const ctx: ConfigContext = useMemo(
		() => ({
			project,
			definition,
			services: detail.status.services,
			suggestedPort: suggestedPort ?? null,
		}),
		[project, definition, detail.status.services, suggestedPort],
	);
	return <ConfigForm key={`${project}/${type}`} ctx={ctx} />;
}

interface ConfigFormProps {
	readonly ctx: ConfigContext;
}

function ConfigForm({ ctx }: ConfigFormProps) {
	const { project, definition } = ctx;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [defaults] = useState(() => buildDefaults(ctx));
	const [serverPort, setServerPort] = useState<number | undefined>();
	const form = useForm({
		defaultValues: defaults,
		onSubmit: async ({ value }) => {
			try {
				const opId = await addService(project, toAddBody(value, ctx));
				const settled = trackOp(opId, {
					title: `Adding ${value.name}…`,
					queryClient,
					invalidate: invalidationFor({ kind: "service-set", project }),
				});
				// The op writes locastack.yaml shortly after the 202 (or after
				// other ops of the project); open the detail page once its
				// "Added" event arrives (stay here if the op fails first).
				if (!(await waitForService(project, value.name, opId, settled))) return;
				await Promise.all(
					invalidationFor({ kind: "service-set", project }).map((filters) =>
						queryClient.invalidateQueries(filters),
					),
				);
				navigate(`/p/${project}/s/${value.name}`);
			} catch (error) {
				if (
					error instanceof ApiRequestError &&
					error.code === "SERVICE_EXISTS"
				) {
					form.setFieldMeta("name", withServerError(error.message));
				} else if (
					error instanceof ApiRequestError &&
					error.code === "PORT_CONFLICT"
				) {
					form.setFieldMeta("port", withServerError(error.message));
					setServerPort(error.suggestedPort);
				} else toast.error(errorMessage(error));
			}
		},
	});
	const values = useStore(form.store, (s) => s.values);
	const [isValid, isSubmitting] = useStore(form.store, (s) => [
		s.isValid,
		s.isSubmitting,
	]);
	const portError = useStore(form.store, (s) =>
		firstError(s.fieldMeta.port?.errors ?? []),
	);
	const [yamlDraft, setYamlDraft] = useState<string | null>(null);
	const [yamlError, setYamlError] = useState<string | null>(null);
	const fieldErrors = configErrors(definition, values.config);
	const suggestion = portError
		? (serverPort ?? portSuggestion(values, ctx))
		: undefined;
	const yamlText =
		yamlDraft ?? entryToYaml(values.name, toStackEntry(values, ctx));

	/** Form edits win over a YAML draft: the editor shows the form again. */
	const formEdited = () => {
		setYamlDraft(null);
		setYamlError(null);
	};

	const onYaml = (text: string) => {
		setYamlDraft(text);
		const parsed = yamlToEntry(text, definition.id);
		if (!parsed.ok) {
			setYamlError(parsed.error);
			return;
		}
		setYamlError(null);
		const name = parsed.name;
		form.setFieldValue("name", name);
		form.setFieldValue(
			"config",
			Object.fromEntries(
				Object.entries(definition.config).map(([key, spec]) => [
					key,
					parsed.config?.[key] ?? resolveDefault(spec.default, project, name),
				]),
			),
		);
		if (parsed.version !== undefined)
			form.setFieldValue("version", parsed.version);
		if (parsed.port !== undefined) form.setFieldValue("port", parsed.port);
		if (parsed.persist !== undefined)
			form.setFieldValue("persist", parsed.persist);
		if (definition.seed) form.setFieldValue("seed", parsed.seed ?? "");
	};

	const regenerate = (secret: string) =>
		form.setFieldValue("secrets", {
			...form.getFieldValue("secrets"),
			[secret]: generateSecret(),
		});

	const submit = () => {
		if (!isValid) toast("Fix the highlighted fields first");
		void form.handleSubmit();
	};

	const volume = definition.volumes[0]?.name;

	return (
		<>
			<Link
				to={`/p/${project}/add`}
				className="self-start text-[13px] text-muted-foreground hover:text-foreground"
			>
				← Catalog
			</Link>
			<div className="flex flex-wrap items-center gap-3">
				<BrandChip type={definition.id} icon={definition.icon} size="lg" />
				<div className="min-w-[200px] flex-1">
					<h1 className="m-0 font-semibold text-[22px] tracking-[-0.02em]">
						New {definition.name}
					</h1>
					<p className="mt-0.5 text-[13px] text-muted-foreground">
						{imageOf(definition, values.version)} in project {project}
					</p>
				</div>
				<Link
					to={`/p/${project}`}
					className={cn(
						buttonVariants({ variant: "outline" }),
						"h-8 rounded-control px-3",
					)}
				>
					Cancel
				</Link>
				<Button
					className={cn("h-8 rounded-control px-3", !isValid && "opacity-45")}
					aria-disabled={!isValid}
					disabled={isSubmitting}
					onClick={submit}
				>
					Add &amp; start
				</Button>
			</div>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-4">
				<form
					aria-label={`New ${definition.name}`}
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
					className="flex flex-col gap-3.5 rounded-card border p-[18px]"
				>
					<form.Field
						name="name"
						validators={{
							onMount: ({ value }) => validateInstanceName(value, ctx),
							onChange: ({ value }) => validateInstanceName(value, ctx),
						}}
						listeners={{
							onChange: () => {
								form.setFieldMeta("name", withoutServerError);
								formEdited();
							},
						}}
					>
						{(field) => {
							const nameError = firstError(field.state.meta.errors);
							return (
								<Field data-invalid={Boolean(nameError)} className="gap-1.5">
									<FieldLabel htmlFor="svc-name" className="text-[13px]">
										Name
									</FieldLabel>
									<Input
										id="svc-name"
										value={field.state.value}
										aria-invalid={Boolean(nameError)}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										className={inputClass}
									/>
									{nameError ? (
										<FieldError className="text-[12px]">{nameError}</FieldError>
									) : null}
								</Field>
							);
						}}
					</form.Field>
					<div className="grid grid-cols-2 gap-3">
						<Field className="gap-1.5">
							<FieldLabel htmlFor="svc-version" className="text-[13px]">
								Version
							</FieldLabel>
							<Select
								value={values.version}
								onValueChange={(v) => {
									if (typeof v === "string") {
										form.setFieldValue("version", v);
										formEdited();
									}
								}}
							>
								<SelectTrigger
									id="svc-version"
									className="h-[34px] w-full rounded-control text-[13px]"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{definition.versions.map((v, i) => (
										<SelectItem key={v} value={v}>
											{i === 0 && v !== "latest" ? `${v} (latest)` : v}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<form.Field
							name="port"
							validators={{
								onMount: ({ value }) => validateHostPort(value, ctx),
								onChange: ({ value }) => validateHostPort(value, ctx),
							}}
							listeners={{
								onChange: () => {
									setServerPort(undefined);
									form.setFieldMeta("port", withoutServerError);
									formEdited();
								},
							}}
						>
							{(field) => (
								<Field data-invalid={Boolean(portError)} className="gap-1.5">
									<FieldLabel htmlFor="svc-port" className="text-[13px]">
										Host port
									</FieldLabel>
									<Input
										id="svc-port"
										inputMode="numeric"
										value={field.state.value}
										placeholder={AUTO_PORT}
										aria-invalid={Boolean(portError)}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value.trim())}
										className={cn(inputClass, "font-mono")}
									/>
								</Field>
							)}
						</form.Field>
					</div>
					{portError ? (
						<div
							role="alert"
							className="-mt-1.5 flex items-center gap-2.5 rounded-control bg-muted px-2.5 py-2 text-[12px]"
						>
							<span className="flex-1 font-medium">{portError}</span>
							{suggestion ? (
								<Button
									type="button"
									variant="outline"
									size="xs"
									className="h-6 rounded-[4px] text-[11px]"
									onClick={() => form.setFieldValue("port", String(suggestion))}
								>
									Use {suggestion}
								</Button>
							) : null}
						</div>
					) : null}
					{Object.keys(definition.config).length ? (
						<form.Field
							name="config"
							validators={{
								onMount: ({ value }) =>
									Object.values(configErrors(definition, value))[0],
								onChange: ({ value }) =>
									Object.values(configErrors(definition, value))[0],
							}}
							listeners={{ onChange: formEdited }}
						>
							{(field) => (
								<div className="grid grid-cols-2 gap-3">
									{Object.entries(definition.config).map(([key, spec]) => (
										<Field
											key={key}
											data-invalid={Boolean(fieldErrors[key])}
											className="gap-1.5"
										>
											<FieldLabel
												htmlFor={`cfg-${key}`}
												className="text-[13px]"
											>
												{configLabel(key)}
											</FieldLabel>
											<Input
												id={`cfg-${key}`}
												value={field.state.value[key] ?? ""}
												title={spec.description ?? key}
												aria-invalid={Boolean(fieldErrors[key])}
												onBlur={field.handleBlur}
												onChange={(e) =>
													field.handleChange({
														...field.state.value,
														[key]: e.target.value,
													})
												}
												className={inputClass}
											/>
											{fieldErrors[key] ? (
												<FieldError className="text-[12px]">
													{fieldErrors[key]}
												</FieldError>
											) : (
												<FieldDescription className="font-mono text-[11px]">
													{key}
												</FieldDescription>
											)}
										</Field>
									))}
								</div>
							)}
						</form.Field>
					) : null}
					{definition.secrets.map((secret) => {
						const chosen = values.secrets[secret];
						return (
							<Field key={secret} className="gap-1.5">
								<FieldLabel
									htmlFor={`secret-${secret}`}
									className="text-[13px]"
								>
									{secretLabel(secret)}
								</FieldLabel>
								<div className="flex gap-2">
									<Input
										id={`secret-${secret}`}
										readOnly
										value={chosen ?? ""}
										placeholder="generated on create"
										spellCheck={false}
										className={cn(
											inputClass,
											"min-w-0 flex-1 bg-subtle font-mono text-[12px]",
										)}
									/>
									<Button
										type="button"
										variant="outline"
										className="h-[34px] rounded-control px-3 text-[12px]"
										aria-label={`Regenerate ${secretLabel(secret).toLowerCase()}`}
										onClick={() => regenerate(secret)}
									>
										Regenerate
									</Button>
								</div>
								<FieldDescription className="text-[12px]">
									{chosen
										? `Sent as ${secret} with Add & start. Reveal it later on the Connect tab.`
										: `The server generates ${secret} when the service is added, or Regenerate picks one here. Reveal it later on the Connect tab.`}
								</FieldDescription>
							</Field>
						);
					})}
					<div className="flex flex-col gap-1.5">
						<span className="font-medium text-[13px]">Data</span>
						<Segmented
							label="Data"
							stretch
							value={values.persist}
							options={PERSIST_OPTIONS}
							onChange={(persist) => {
								form.setFieldValue("persist", persist);
								formEdited();
							}}
						/>
						<span className="text-[12px] text-muted-foreground">
							{values.persist === "ephemeral"
								? "Data is wiped every time the container is removed."
								: volume
									? `Data survives restarts in volume ls-${project}-${values.name || "unnamed"}-${volume}.`
									: "This service keeps no data on disk."}
						</span>
					</div>
					{definition.seed ? (
						<form.Field
							name="seed"
							validators={{
								onMount: ({ value }) => validateSeedPath(value),
								onChange: ({ value }) => validateSeedPath(value),
							}}
							listeners={{ onChange: formEdited }}
						>
							{(field) => {
								const seedError = firstError(field.state.meta.errors);
								return (
									<Field data-invalid={Boolean(seedError)} className="gap-1.5">
										<FieldLabel htmlFor="svc-seed" className="text-[13px]">
											Seed file{" "}
											<span className="font-normal text-[#a3a3a3]">
												optional
											</span>
										</FieldLabel>
										<Input
											id="svc-seed"
											value={field.state.value}
											placeholder={`./${definition.seed?.fileName ?? "seed.sql"}`}
											spellCheck={false}
											aria-invalid={Boolean(seedError)}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											className={cn(inputClass, "font-mono text-[12px]")}
										/>
										{seedError ? (
											<FieldError className="text-[12px]">
												{seedError}
											</FieldError>
										) : (
											<FieldDescription className="text-[12px]">
												Relative to the project folder. Mounted read-only at{" "}
												<code className="font-mono">
													{definition.seed?.mountPath}/
													{definition.seed?.fileName}
												</code>{" "}
												and run when the data volume is first created.
											</FieldDescription>
										)}
									</Field>
								);
							}}
						</form.Field>
					) : null}
					<button type="submit" hidden aria-hidden tabIndex={-1} />
				</form>
				<YamlEditor value={yamlText} error={yamlError} onChange={onYaml} />
			</div>
		</>
	);
}
