import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { ApiError, api } from '@/lib/api';
import { isE2eeEnabled } from './policy';
import { claimLegacyOutboxEnvelopes } from './atomic';
import {
  loadE2eeAccount,
  openE2eeDatabase,
  saveE2eeAccount,
  type E2eeAccountRow,
} from './db';
import { purgeExpiredMessages } from './ephemeral';
import { withAccountLock } from './locks';
import { sweepDurablePartials, sweepSecureMedia } from './mediaStore';

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
let bootstrapGate: Promise<unknown> = Promise.resolve();

export function bootstrapE2ee(token: string, userId: string): Promise<BootstrapResult> {
  const next = bootstrapGate.then(
    () => bootstrapE2eeUnlocked(token, userId),
    () => bootstrapE2eeUnlocked(token, userId),
  );
  bootstrapGate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function bootstrapE2eeUnlocked(token: string, userId: string): Promise<BootstrapResult> {
  if (!isE2eeEnabled()) {
    return { disabled: true, recovered: false, registered: false };
  }
  // Un démarrage laisse toujours le dossier privé vide : s'il restait un clair
  // d'une session arrêtée en plein visionnage, il disparaît avant tout accès.
  sweepSecureMedia();
  // Les ciphertexts durables ne sont jamais balayés ici : seuls les `.part`
  // d'une écriture interrompue le sont. Le balayage s'abstient de lui-même si
  // une écriture est en cours dans ce processus.
  sweepDurablePartials();
  const { db, recovered } = await openE2eeDatabase(userId);
  try {
    // L'échéance peut avoir expiré pendant que l'application était fermée.
    await purgeExpiredMessages(db).catch(() => undefined);
    let account = await loadE2eeAccount(db);
    if (account?.user_id && account.user_id !== userId) {
      // Le routage par compte doit avoir choisi la bonne base. Une base mal
      // attribuée est une erreur d'intégrité : on refuse de l'utiliser ou de
      // la supprimer, car elle contient peut-être l'historique de l'autre compte.
      throw new Error('e2ee_account_mismatch');
    }
    let createdNow = false;
    if (!account) {
      createdNow = true;
      const identity = await MboloCrypto.secureCreateAccount();
      const signedKeys = await MboloCrypto.secureGenerateOneTimeKeysSigned(identity.account_pickle, 5);
      const fallback = await MboloCrypto.secureGenerateFallbackKey(signedKeys.account_pickle);
      account = {
        account_pickle: fallback.account_pickle,
        device_id: null,
        user_id: userId,
        identity_key: identity.curve25519,
        signing_key: identity.ed25519,
        fallback_key: fallback.key,
        fallback_signature: fallback.signature,
        fallback_key_id: fallback.key_id,
      };
      await saveE2eeAccount(db, account);
    } else if (!account.user_id) {
      // Base antérieure à la migration : le compte connecté devient propriétaire.
      account = { ...account, user_id: userId };
      await saveE2eeAccount(db, account);
    }
    // Copie non nulle et stable : le compte est lu puis remplacé dans les
    // sections verrouillées ci-dessous.
    const base: E2eeAccountRow = account;
    // Une identité existante est forcément celle du compte courant : la base
    // aurait été supprimée par la branche précédente sinon. Les enveloppes
    // antérieures à la colonne `account_id` peuvent donc être rattachées sans
    // risque et redevenir reprenables. On ne le fait pas après une perte de
    // clés (`createdNow`) : ces anciennes enveloppes ne seraient plus
    // déchiffrables par les correspondants.
    if (!createdNow) {
      await claimLegacyOutboxEnvelopes(db, base.identity_key);
    }

    // Ne jamais confondre « le serveur ne connaît pas cet appareil » avec
    // « le statut est momentanément indisponible ». Une panne réseau ne doit
    // pas déclencher une réinscription ni régénérer des prekeys : on laisse
    // l'état `degraded` et la reprise automatique republiera plus tard.
    let status: Awaited<ReturnType<typeof api.getE2eeStatus>>;
    try {
      status = await api.getE2eeStatus(token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new Error('e2ee_unavailable');
      }
      if (
        error instanceof ApiError &&
        error.status !== 0 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        throw error;
      }
      throw new Error('e2ee_status_network');
    }
    // Compte recréé localement (perte de clés) : le serveur garde l'ancienne
    // identité sous le même deviceId — il faut republier, même si « registered ».
    const needsRegistration = createdNow || !status?.registered || !status?.fallbackAvailable;
    // Le pickle de compte est global : toute génération de clés part de l'état
    // **relu sous verrou**, et l'écriture se fait dedans. Le réseau, lui, reste
    // dehors : rien n'est publié en tenant le verrou.
    if (needsRegistration) {
      const prepared = await withAccountLock(base.identity_key, async () => {
        const current: E2eeAccountRow = (await loadE2eeAccount(db)) ?? base;
        const fallback =
          current.fallback_key && current.fallback_signature && current.fallback_key_id
            ? {
                key: current.fallback_key,
                signature: current.fallback_signature,
                keyId: current.fallback_key_id,
                account_pickle: current.account_pickle,
              }
            : await MboloCrypto.secureGenerateFallbackKey(current.account_pickle).then(
                (generated) => ({
                  key: generated.key,
                  signature: generated.signature,
                  keyId: generated.key_id,
                  account_pickle: generated.account_pickle,
                }),
              );
        const signedKeys = await MboloCrypto.secureGenerateOneTimeKeysSigned(
          fallback.account_pickle,
          5,
        );
        const next: E2eeAccountRow = {
          ...current,
          account_pickle: signedKeys.account_pickle,
          fallback_key: fallback.key,
          fallback_signature: fallback.signature,
          fallback_key_id: fallback.keyId,
        };
        // Écrit avant la publication : ces clés privées n'existent que là, et
        // l'écriture est le seul moment où le pickle peut être écrasé.
        await saveE2eeAccount(db, next);
        return { next, fallback, signedKeys };
      });
      const registration = await api.registerE2eeDevice(token, {
        identityKey: prepared.next.identity_key,
        signingKey: prepared.next.signing_key,
        fallbackPrekey: prepared.fallback.key,
        fallbackPrekeySignature: prepared.fallback.signature,
        fallbackPrekeyKeyId: prepared.fallback.keyId,
        oneTimeKeys: prepared.signedKeys.keys.map((key) => ({
          keyId: key.key_id,
          key: key.key,
          signature: key.signature,
        })),
      });
      // Seul `device_id` est ajouté : le pickle relu peut avoir avancé pendant
      // l'appel réseau (prekey entrante) et ne doit pas être remplacé.
      account = await withAccountLock(base.identity_key, async () => {
        const current = (await loadE2eeAccount(db)) ?? prepared.next;
        const merged: E2eeAccountRow = { ...current, device_id: registration.deviceId };
        await saveE2eeAccount(db, merged);
        return merged;
      });
    } else if ((status?.prekeysRemaining ?? 0) < 5) {
      const prepared = await withAccountLock(base.identity_key, async () => {
        const current: E2eeAccountRow = (await loadE2eeAccount(db)) ?? base;
        const signedKeys = await MboloCrypto.secureGenerateOneTimeKeysSigned(
          current.account_pickle,
          5,
        );
        await saveE2eeAccount(db, { ...current, account_pickle: signedKeys.account_pickle });
        return signedKeys;
      });
      await api.addE2eePrekeys(
        token,
        prepared.keys.map((key) => ({
          keyId: key.key_id,
          key: key.key,
          signature: key.signature,
        })),
      );
      account = (await loadE2eeAccount(db)) ?? base;
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
