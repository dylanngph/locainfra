import { useQuery } from "@tanstack/react-query";
import { StatusDot } from "@/shared/components/status";
import { systemQuery } from "../api/system.queries";

/** Header Docker indicator: green dot + version, red when the daemon is down. */
export function DockerStatus() {
	const { data, isError, isPending } = useQuery(systemQuery());
	const docker = data?.docker;
	const label = isPending
		? "Docker…"
		: isError
			? "Server unreachable"
			: docker
				? `Docker ${docker.version}`
				: "Docker not running";
	const tone = isPending ? "stopped" : docker ? "running" : "error";
	return (
		<div
			className="flex items-center gap-[7px] whitespace-nowrap text-[12px] text-muted-foreground"
			title={data?.compose ? `Compose ${data.compose}` : undefined}
		>
			<StatusDot tone={tone} className="size-[7px]" />
			{label}
		</div>
	);
}
