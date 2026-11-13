import type { StoredE2eeMessage } from '@/features/e2ee/db';

/**
 * Copie **verbatim** de `sortMessages` de `app/e2ee-chat/[id].tsx`
 * (état HEAD `3a8bdc8`), pour les tests de caractérisation B.2.
 *
 * Aucun comportement n'est modifié : l'écran garde sa définition jusqu'à
 * B.3.5. L'insertion triée incrémentale de B.3.1 devra prouver son équivalence
 * avec cette fonction.
 */
export function sortMessages(messages: StoredE2eeMessage[]): StoredE2eeMessage[] {
  const seen = new Set<string>();
  return [...messages]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
}
