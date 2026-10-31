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
      const keys = await MboloCrypto.secureGenerateOneTimeKeys(identity.account_pickle, 5);
      account = {
        account_pickle: keys.account_pickle,
        device_id: null,
        identity_key: identity.curve25519,
        signing_key: identity.ed25519,
      };
      await saveE2eeAccount(db, account);
    }

    const status = await api.getE2eeStatus(token).catch(() => null);
    if (!status?.registered) {
      const keys = await MboloCrypto.secureGenerateOneTimeKeys(account.account_pickle, 5);
      const registration = await api.registerE2eeDevice(token, {
        identityKey: account.identity_key,
        signingKey: account.signing_key,
        oneTimeKeys: keys.keys.map((key) => ({ keyId: key.key_id, key: key.key })),
      });
      account = {
        ...account,
        account_pickle: keys.account_pickle,
        device_id: registration.deviceId,
      };
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
