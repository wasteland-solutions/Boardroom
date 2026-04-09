CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`cwd` text NOT NULL,
	`model` text NOT NULL,
	`permission_mode` text NOT NULL,
	`sdk_session_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cwds` (
	`path` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`sdk_message_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conv_seq_idx` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_conv_created_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pending_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_conv_status_idx` ON `pending_permissions` (`conversation_id`,`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
