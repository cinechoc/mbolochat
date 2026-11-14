import { useCallback, useEffect, useMemo, useReducer } from 'react';

import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../model/messages-state';
import { unreadBoundary } from '../model/merge';
import { buildChatRows, type ChatRow } from '../model/rows';
import type { ChatTransport } from '../transport/types';

/**
 * État des messages d'un transport. La logique (fusion, suppression, accusés,
 * réactions) vit dans `messages-state.ts` ; le hook ne branche que React et le
 * transport.
 */
export function useChatMessages(input: {
  transport: ChatTransport | null;
  timeGapMs: number;
  currentUserId: string;
  /** Nombre de messages non lus fourni par le résumé serveur. */
  unreadCount?: number;
}): {
  messages: ReturnType<typeof messagesReducer>['messages'];
  rows: ChatRow[];
  receipts: ReturnType<typeof messagesReducer>['receipts'];
  ready: boolean;
  hasMore: boolean;
  error: string | null;
  typing: { userId: string; text: string } | null;
  online: boolean;
  loadOlder: () => Promise<void>;
} {
  const { transport, timeGapMs, currentUserId, unreadCount = 0 } = input;
  const [state, dispatch] = useReducer(messagesReducer, INITIAL_MESSAGES_STATE);

  useEffect(() => {
    if (!transport) return;
    dispatch({ type: 'reset' });
    let active = true;

    void transport
      .loadInitial()
      .then((snapshot) => {
        if (active) dispatch({ type: 'snapshot', snapshot });
      })
      .catch((cause: unknown) => {
        if (active) {
          dispatch({
            type: 'error',
            error: cause instanceof Error ? cause.message : null,
          });
        }
      })
      .finally(() => {
        if (active) dispatch({ type: 'ready' });
      });

    const off = transport.subscribe({
      onMessage: (message) => dispatch({ type: 'upsert', message }),
      onMessageRemoved: (id, forEveryone) => dispatch({ type: 'remove', id, forEveryone }),
      onReceipts: (receipts) => dispatch({ type: 'receipts', receipts }),
      onReaction: (id, reactions) => dispatch({ type: 'reaction', id, reactions }),
      onTyping: (typing) => dispatch({ type: 'typing', typing }),
      onConnection: (online) => dispatch({ type: 'connection', online }),
      onConversationUpdated: () => undefined,
      onConversationRemoved: () => undefined,
      onError: (error) => dispatch({ type: 'error', error }),
      onFatal: () => undefined,
    });

    return () => {
      active = false;
      off();
    };
  }, [transport]);

  const loadOlder = useCallback(async () => {
    if (!transport || !state.hasMore || state.messages.length === 0) return;
    const oldest = state.messages[0];
    const page = await transport.loadOlder(oldest.createdAt, oldest.id);
    for (const message of page.messages) {
      dispatch({ type: 'upsert', message });
    }
    dispatch({ type: 'hasMore', hasMore: page.hasMore });
  }, [transport, state.hasMore, state.messages]);

  const unreadFrom = useMemo(
    () => unreadBoundary(state.messages, unreadCount, currentUserId),
    [state.messages, unreadCount, currentUserId],
  );

  const rows = useMemo(
    () =>
      buildChatRows({
        messages: state.messages,
        timeGapMs,
        unreadFrom,
      }),
    [state.messages, timeGapMs, unreadFrom],
  );

  return {
    messages: state.messages,
    rows,
    receipts: state.receipts,
    ready: state.ready,
    hasMore: state.hasMore,
    error: state.error,
    typing: state.typing,
    online: state.online,
    loadOlder,
  };
}
