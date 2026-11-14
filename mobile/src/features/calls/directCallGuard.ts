import type { ConversationSummary } from '@/lib/types';

export type DirectCallGuard = 'allow' | 'encrypted';

/** Une conversation directe chiffrée ne doit jamais lancer un appel en clair. */
export function guardDirectCall(
  summary: Pick<ConversationSummary, 'type' | 'e2eeSince'>,
): DirectCallGuard {
  return summary.type === 'DIRECT' && summary.e2eeSince ? 'encrypted' : 'allow';
}
