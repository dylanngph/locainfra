ALTER TABLE `snapshots` ADD `type` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `version` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `has_secrets` integer DEFAULT false NOT NULL;