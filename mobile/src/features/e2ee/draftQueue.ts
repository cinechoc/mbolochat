/**
 * File d'écriture des brouillons chiffrés.
 *
 * Un brouillon est enregistré à chaque frappe. Les écritures SQLCipher sont
 * asynchrones et **ne s'exécutent pas dans l'ordre d'appel** : lancer un
 * `saveDraft()` par frappe laisse une écriture ancienne (texte plus court)
 * arriver après la dernière, et le brouillon relu perd sa fin.
 *
 * Cette file garantit trois propriétés :
 * 1. **sérialisation** : une seule écriture à la fois ;
 * 2. **dernière valeur gagne** : les valeurs intermédiaires sont fusionnées, la
 *    dernière saisie est celle qui reste en base, jamais une plus ancienne ;
 * 3. **aucune écriture avant le chargement** : tant que `enable()` n'a pas été
 *    appelé, les valeurs sont seulement mémorisées — une restauration de
 *    brouillon ne peut donc pas déclencher la sauvegarde d'un texte partiel.
 *
 * Aucune donnée de brouillon n'est conservée en dehors de la base chiffrée :
 * la file ne garde en mémoire que la valeur en attente, le temps de l'écriture.
 */

/** Écriture réelle d'un brouillon (SQLCipher). Peut échouer sans casser la file. */
export type DraftWrite = (value: string) => Promise<unknown>;

export interface DraftQueue {
  /** Mémorise la nouvelle valeur ; l'écrit tout de suite si la file est ouverte. */
  set(value: string): void;
  /** Dernière valeur saisie pas encore écrite (`null` si rien n'attend). */
  pending(): string | null;
  /** Ouvre les écritures (brouillon stocké connu) puis vide ce qui attendait. */
  enable(): void;
  /** Attend que la file soit vide — utilisé au démontage et dans les tests. */
  idle(): Promise<void>;
}

export function createDraftQueue(write: DraftWrite): DraftQueue {
  let latest: string | null = null;
  let armed = false;
  let chain: Promise<unknown> = Promise.resolve();

  /** Ajoute une étape qui écrit la valeur en attente, s'il y en a une. */
  const drain = (): Promise<unknown> => {
    chain = chain
      .then(() => {
        if (latest === null) return;
        const value = latest;
        latest = null;
        return write(value);
      })
      // Une écriture qui échoue ne doit ni bloquer la file ni masquer la
      // saisie suivante : on repart d'une chaîne saine.
      .catch(() => undefined);
    return chain;
  };

  return {
    set(value) {
      latest = value;
      if (armed) void drain();
    },
    pending() {
      return latest;
    },
    enable() {
      armed = true;
      if (latest !== null) void drain();
    },
    async idle() {
      await chain;
    },
  };
}
