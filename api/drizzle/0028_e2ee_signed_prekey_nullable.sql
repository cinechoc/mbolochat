ALTER TABLE "e2ee_devices" ALTER COLUMN "signed_prekey" DROP NOT NULL;
ALTER TABLE "e2ee_devices" ALTER COLUMN "signed_prekey_signature" DROP NOT NULL;
