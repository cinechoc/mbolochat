/**
 * Verrou Olm : une seule mutation de session à la fois, par triplet
 * (compte local, pair, appareil du pair).
 *
 * Une session Olm est un état à progression monotone : deux chiffrements
 * concurrents sur le même S0 produiraient deux enveloppes valides mais un seul
 * S1, donc une des deux enveloppes deviendrait indéchiffrable. Le verrou
 * sérialise ces mutations.
 *
 * Il ne couvre **que** la lecture de S0, le chiffrement et l'écriture S1 + E :
 * aucune opération réseau ne doit être exécutée en le tenant.
 */

export interface OlmLockKey {
  /** Identité stable du compte local (`identity_key`), jamais envoyée au réseau. */
  accountId: string;
  peerUserId: string;
  /** Appareil du pair : deux appareils ont deux sessions indépendantes. */
  peerDeviceId: string;
}

/** File d'attente par clé : le `Promise` courant sert de jeton de tour. */
const queues = new Map<string, Promise<void>>();

/**
 * Files du **compte local**. Map séparée de celle des sessions : les deux
 * espaces de clés n'ont aucune raison de se rencontrer, et une clé de compte
 * ne peut donc jamais tomber sur l'identifiant d'une session.
 */
const accountQueues = new Map<string, Promise<void>>();

export function olmLockId(key: OlmLockKey): string {
  // Séparateur non imprimable : impossible dans un identifiant utilisateur.
  return `${key.accountId}\u0000${key.peerUserId}\u0000${key.peerDeviceId}`;
}

/** Nombre de files vivantes — sert aux tests à vérifier qu'aucune ne fuit. */
export function pendingOlmLocks(): number {
  return queues.size;
}

/**
 * Exécute `task` après toutes les tâches déjà en attente sur la même clé.
 *
 * Deux clés distinctes ne s'attendent jamais : la file est indexée par clé, pas
 * par compte ni globalement.
 */
async function runLocked<T>(
  files: Map<string, Promise<void>>,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = files.get(id) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `tail` ne se résout qu'au `release()` : c'est le tour de la tâche suivante.
  const tail = previous.then(() => gate);
  files.set(id, tail);

  // `previous` et `tail` ne rejettent jamais : une tâche en échec libère sa
  // place sans propager son erreur à la suivante.
  await previous;
  try {
    return await task();
  } finally {
    release();
    // Seule la dernière tâche de la file efface l'entrée : sinon deux arrivées
    // simultanées perdraient le jeton et se chevaucheraient.
    if (files.get(id) === tail) {
      files.delete(id);
    }
  }
}

export function withOlmLock<T>(key: OlmLockKey, task: () => Promise<T>): Promise<T> {
  return runLocked(queues, olmLockId(key), task);
}

/**
 * Verrou du **compte local**, pour le pickle global `e2ee_account`.
 *
 * La session Olm est locale à un couple (pair, appareil) ; le compte ne l'est
 * pas. La consommation d'une prekey entrante fait avancer une copie unique du
 * compte, partagée par tous les pairs : sans ce verrou, deux messages de deux
 * pairs différents partent du même pickle et le dernier écrase l'autre. Les
 * clés à usage unique consommées par le premier resteraient alors dans le
 * compte et pourraient servir deux fois.
 *
 * Invariant d'ordre : ce verrou est **toujours pris à l'intérieur** d'un verrou
 * de session, jamais autour. Aucun cycle possible, donc aucun interblocage.
 * Comme pour les sessions, aucun appel réseau n'est fait en le tenant.
 */
export function withAccountLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  return runLocked(accountQueues, accountId, task);
}

/** Nombre de files de compte vivantes — sert aux tests à vérifier l'absence de fuite. */
export function pendingAccountLocks(): number {
  return accountQueues.size;
}
