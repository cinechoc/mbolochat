import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { isE2eeEnabled } from './policy';
import { loadE2eeAccount, openE2eeDatabase, saveE2eeAccount } from './db';

export interface BootstrapResult {
  disabled: boolean;
  recovered: boolean;
  registered: boolean;
  error?: string;
}

/**
 * Prépare l'appareil E2EE : clés protégées par le Keystore, base SQLCipher,
 * identité Olm et publication des clés publiques. Aucun secret ne sort de
 * l'appareil, hormis les clés publiques.
 */
export async function bootstrapE2ee(token: string): Promise<BootstrapResult> {
  if (!isE2eeEnabled()) {
    return { disabled: true, recovered: false, registered: false };
  }
  const { db, recovered } = await openE2eeDatabase();
  try {
    let account = await loadE2eeAccount(db);
    if (!account) {
      const identity = await MboloCrypto.secureCreateAccount();
      const signedKeys = await MboloCrypto.secureGenerateOneTimeKeysSigned(identity.account_pickle, 5);
      const fallback = await MboloCrypto.secureGenerateFallbackKey(signedKeys.account_pickle);
      account = {
        account_pickle: fallback.account_pickle,
        device_id: null,
        identity_key: identity.curve25519,
        signing_key: identity.ed25519,
        fallback_key: fallback.key,
        fallback_signature: fallback.signature,
        fallback_key_id: fallback.key_id,
      };
      await saveE2eeAccount(db, account);
    }

    const status = await api.getE2eeStatus(token).catch(() => null);
    const needsRegistration = !status?.registered || !status?.fallbackAvailable;
    if (needsRegistration) {
      let fallback: {
        key?: string;
        signature?: string;
        keyId?: string;
        account_pickle: string;
      } = {
        key: account.fallback_key ?? undefined,
        signature: account.fallback_signature ?? undefined,
        keyId: account.fallback_key_id ?? undefined,
        account_pickle: account.account_pickle,
      };
      if (!fallback.key || !fallback.signature || !fallback.keyId) {
        const generated = await MboloCrypto.secureGenerateFallbackKey(account.account_pickle);
        fallback = {
          key: generated.key,
          signature: generated.signature,
          keyId: generated.key_id,
          account_pickle: generated.account_pickle,
        };
      }
      const signedKeys = await MboloCrypto.secureGenerateOneTimeKeysSigned(
        fallback.account_pickle,
        5,
      );
      const registration = await api.registerE2eeDevice(token, {
        identityKey: account.identity_key,
        signingKey: account.signing_key,
        fallbackPrekey: fallback.key,
        fallbackPrekeySignature: fallback.signature,
        fallbackPrekeyKeyId: fallback.keyId,
        oneTimeKeys: signedKeys.keys.map((key) => ({
          keyId: key.key_id,
          key: key.key,
          signature: key.signature,
        })),
      });
      account = {
        ...account,
        account_pickle: signedKeys.account_pickle,
        device_id: registration.deviceId,
        fallback_key: fallback.key,
        fallback_signature: fallback.signature,
        fallback_key_id: fallback.keyId,
      };
      await saveE2eeAccount(db, account);
    } else if ((status?.prekeysRemaining ?? 0) < 5) {
      const signedKeys = await MboloCrypto.secureGenerateOneTimeKeysSigned(
        account.account_pickle,
        5,
      );
      await api.addE2eePrekeys(
        token,
        signedKeys.keys.map((key) => ({
          keyId: key.key_id,
          key: key.key,
          signature: key.signature,
        })),
      );
      account = { ...account, account_pickle: signedKeys.account_pickle };
      await saveE2eeAccount(db, account);
    }

    return { disabled: false, recovered, registered: true };
  } catch (error) {
    return {
      disabled: false,
      recovered,
      registered: false,
      error: error instanceof Error ? error.message : 'e2ee_bootstrap_failed',
    };
  } finally {
    await db.closeAsync().catch(() => undefined);
  }
}
