CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ops` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`service` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error_json` text
);
--> statement-breakpoint
CREATE INDEX `ops_project_started_idx` ON `ops` (`project`,`started_at`);--> statement-breakpoint
CREATE TABLE `port_pins` (
	`project` text NOT NULL,
	`service` text NOT NULL,
	`port` integer NOT NULL,
	PRIMARY KEY(`project`, `service`),
	FOREIGN KEY (`project`) REFERENCES `stacks`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `port_pins_port_unique` ON `port_pins` (`port`);--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`root` text NOT NULL,
	`env_file` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registry` (
	`id` integer PRIMARY KEY NOT NULL,
	`etag` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "registry_single_row" CHECK("registry"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`service` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `snapshots_project_service_idx` ON `snapshots` (`project`,`service`);--> statement-breakpoint
CREATE TABLE `stacks` (
	`name` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
