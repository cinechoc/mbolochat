ALTER TABLE "conversations" ADD COLUMN "e2ee_since" timestamp with time zone;
ALTER TABLE "messages" ADD COLUMN "encryption" text DEFAULT 'none' NOT NULL;
ALTER TABLE "messages" ADD COLUMN "payload" text;
ALTER TABLE "messages" ADD COLUMN "sender_device_id" text;
ALTER TABLE "refresh_tokens" ADD COLUMN "device_id" text;

CREATE TABLE "e2ee_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "device_id" text NOT NULL,
  "identity_key" text NOT NULL,
  "signing_key" text NOT NULL,
  "signed_prekey" text,
  "signed_prekey_signature" text,
  "device_name" text,
  "platform" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "e2ee_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX "e2ee_devices_user_device_idx" ON "e2ee_devices" ("user_id","device_id");
CREATE UNIQUE INDEX "e2ee_devices_active_user_idx" ON "e2ee_devices" ("user_id") WHERE "revoked_at" IS NULL;

CREATE TABLE "e2ee_one_time_prekeys" (
  "id" text PRIMARY KEY NOT NULL,
  "device_row_id" text NOT NULL,
  "key_id" text NOT NULL,
  "public_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "used_at" timestamp with time zone,
  CONSTRAINT "e2ee_one_time_prekeys_device_row_id_e2ee_devices_id_fk" FOREIGN KEY ("device_row_id") REFERENCES "e2ee_devices"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX "e2ee_prekeys_device_key_idx" ON "e2ee_one_time_prekeys" ("device_row_id","key_id");
CREATE INDEX "e2ee_prekeys_device_used_idx" ON "e2ee_one_time_prekeys" ("device_row_id","used_at");
