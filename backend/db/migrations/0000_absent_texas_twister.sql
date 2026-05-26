CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
