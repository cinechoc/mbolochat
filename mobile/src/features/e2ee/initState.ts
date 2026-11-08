import { fr } from '@/i18n/fr';

/**
 * État d'initialisation E2EE, partagé par la porte de démarrage et l'écran de
 * conversation chiffrée.
 *
 * Deux niveaux d'échec, volontairement distincts :
 * - `failed`  : la base chiffrée ou le Keystore n'a pas pu être ouvert. Rien ne
 *   doit prétendre que le chiffrement est prêt.
 * - `degraded`: la base locale est ouverte (les messages existants restent
 *   lisibles) mais la publication des clés publiques a échoué (réseau). Les
 *   nouvelles sessions entrantes peuvent manquer, l'existant continue.
 *
 * Aucun message d'exception brut n'est conservé : seule une catégorie finie,
 * pour ne jamais exposer chemins, clés ou internes dans l'interface ou les logs.
 */
export type E2eeInitFailure = 'storage' | 'crypto' | 'network' | 'unknown';

export type E2eeInitState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ready' }
  | { status: 'degraded'; failure: E2eeInitFailure }
  | { status: 'failed'; failure: E2eeInitFailure };

const STORAGE =
  /sqlite|sqlcipher|database|disk|keystore|cipher|storage|migration|no such column|corrupt/i;
const CRYPTO = /crypto|pickle|olm|ratchet|engine|identity|prekey|account_missing|keys? missing/i;
const NETWORK = /network|fetch|timeout|offline|socket|api|http|unreachable|abort/i;

/** Catégorie d'une erreur d'initialisation, à partir de son seul message. */
export function classifyE2eeFailure(cause: unknown): E2eeInitFailure {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (STORAGE.test(text)) return 'storage';
  if (CRYPTO.test(text)) return 'crypto';
  if (NETWORK.test(text)) return 'network';
  return 'unknown';
}

/** Libellés affichables : jamais de contenu d'exception, jamais de secret. */
export function describeE2eeFailure(failure: E2eeInitFailure): { title: string; body: string } {
  switch (failure) {
    case 'storage':
      return { title: fr.e2ee.initStorageTitle, body: fr.e2ee.initStorageBody };
    case 'crypto':
      return { title: fr.e2ee.initCryptoTitle, body: fr.e2ee.initCryptoBody };
    case 'network':
      return { title: fr.e2ee.initNetworkTitle, body: fr.e2ee.initNetworkBody };
    default:
      return { title: fr.e2ee.initFailedTitle, body: fr.e2ee.initFailedBody };
  }
}

let state: E2eeInitState = { status: 'idle' };
const listeners = new Set<() => void>();

export function getE2eeInitState(): E2eeInitState {
  return state;
}

export function setE2eeInitState(next: E2eeInitState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeE2eeInit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let keysLostNotified = false;

/**
 * Alerte « clés perdues » : un seul affichage, que la porte de démarrage ou
 * l'écran chiffré arrive en premier.
 */
export function claimKeysLostNotice(recovered: boolean | undefined): boolean {
  if (!recovered || keysLostNotified) return false;
  keysLostNotified = true;
  return true;
}

/** Remise à zéro (déconnexion, tests) : ne laisse aucun état « prêt » hérité. */
export function resetE2eeInitState(): void {
  keysLostNotified = false;
  setE2eeInitState({ status: 'idle' });
}
