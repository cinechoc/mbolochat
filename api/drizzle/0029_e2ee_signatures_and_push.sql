ALTER TABLE "e2ee_one_time_prekeys" ADD COLUMN "signature" text;
ALTER TABLE "e2ee_devices" ADD COLUMN "fallback_prekey" text;
ALTER TABLE "e2ee_devices" ADD COLUMN "fallback_prekey_signature" text;
ALTER TABLE "e2ee_devices" ADD COLUMN "fallback_prekey_key_id" text;
ALTER TABLE "push_tokens" ADD COLUMN "device_id" text;
