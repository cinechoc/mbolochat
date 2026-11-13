import { directPeerOf } from '@/features/e2ee/routing';
import type { ConversationSummary } from '@/lib/types';

/**
 * Résolution du mode d'une conversation, avec anti-downgrade.
 *
 * Le résumé serveur prime ; à défaut, le résumé mis en cache localement est
 * utilisé (ouverture hors ligne). Un résumé absent, partiel ou dont le champ
 * `e2eeSince` est `undefined` est **inconnu** : jamais « en clair » par défaut.
 * L'écran affiche alors une attente sans compositeur.
 */
export type ChatModeResolution =
  | { kind: 'classic'; summary: ConversationSummary }
  | {
      kind: 'e2ee';
      summary: ConversationSummary;
      peer: NonNullable<ReturnType<typeof directPeerOf>>;
    }
  | { kind: 'blocked'; reason: 'peer_missing' | 'group_mismatch' }
  | { kind: 'pending'; reason: 'summary_unknown' };

export interface ResolveChatModeInput {
  conversationId: string;
  serverSummary: ConversationSummary | null;
  cachedSummary: ConversationSummary | null;
  e2eeEnabled: boolean;
  currentUserId: string | null;
  /** Réseau disponible : documente l'attente, ne change pas la règle. */
  online: boolean;
}

export function resolveChatMode(input: ResolveChatModeInput): ChatModeResolution {
  const summary = input.serverSummary ?? input.cachedSummary;
  if (!summary || summary.id !== input.conversationId) {
    return { kind: 'pending', reason: 'summary_unknown' };
  }
  // Ancien cache (ou réponse tronquée) : champ absent ≠ conversation claire.
  const e2eeSince = (summary as { e2eeSince?: string | null }).e2eeSince;
  if (typeof e2eeSince === 'undefined') {
    return { kind: 'pending', reason: 'summary_unknown' };
  }
  if (!e2eeSince) {
    return { kind: 'classic', summary };
  }
  // Le drapeau E2EE désactivé est une configuration explicite, pas un doute :
  // le serveur reste l'autorité et refusera tout envoi clair.
  if (!input.e2eeEnabled) {
    return { kind: 'classic', summary };
  }
  if (summary.type !== 'DIRECT') {
    return { kind: 'blocked', reason: 'group_mismatch' };
  }
  const peer = directPeerOf(summary, input.currentUserId);
  if (!peer) {
    return { kind: 'blocked', reason: 'peer_missing' };
  }
  return { kind: 'e2ee', summary, peer };
}
