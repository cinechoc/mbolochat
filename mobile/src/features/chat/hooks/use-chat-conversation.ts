import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ConversationSummary } from '@/lib/types';
import { resolveChatMode, type ChatModeResolution } from '../mode/resolve-chat-mode';

type ChatApi = Pick<typeof import('@/lib/api').api, 'getConversation'>;
type ChatCache = Pick<typeof import('@/lib/cache').cache, 'getConversation'>;

/**
 * Résumé serveur + repli cache, puis résolution du mode (anti-downgrade).
 * Aucun écran n'instancie un transport avant que le mode soit établi.
 */
export function useChatConversation(input: {
  conversationId: string;
  token: string | null;
  currentUserId: string | null;
  e2eeEnabled: boolean;
  online: boolean;
  api: ChatApi;
  cache: ChatCache;
}): {
  resolution: ChatModeResolution;
  serverSummary: ConversationSummary | null;
  loading: boolean;
  refresh: () => void;
} {
  const { api, cache, conversationId, token } = input;
  const [serverSummary, setServerSummary] = useState<ConversationSummary | null>(null);
  const [loading, setLoading] = useState(Boolean(input.token && input.conversationId));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token || !conversationId) {
      return;
    }
    let active = true;
    void api
      .getConversation(token, conversationId)
      .then((summary) => {
        if (active) setServerSummary(summary);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, conversationId, token, attempt]);

  // Lecture synchrone (Map en mémoire) : pas de mémoïsation nécessaire, et le
  // rafraîchissement relit bien le cache mis à jour.
  const cachedSummary = cache.getConversation(conversationId);

  const resolution = useMemo(
    () =>
      resolveChatMode({
        conversationId,
        serverSummary,
        cachedSummary,
        e2eeEnabled: input.e2eeEnabled,
        currentUserId: input.currentUserId,
        online: input.online,
      }),
    [
      conversationId,
      serverSummary,
      cachedSummary,
      input.e2eeEnabled,
      input.currentUserId,
      input.online,
    ],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    setAttempt((value) => value + 1);
  }, []);

  return { resolution, serverSummary, loading, refresh };
}
