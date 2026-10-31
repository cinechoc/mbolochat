ALTER TABLE "users" ALTER COLUMN "group_add_permission" SET DEFAULT 'everyone';
--> statement-breakpoint
UPDATE "users" SET "group_add_permission" = 'everyone' WHERE "group_add_permission" = 'contacts';
