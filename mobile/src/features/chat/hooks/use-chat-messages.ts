import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageReceipt } from '@/lib/types';
import { MessageIndex } from '../model/message-index';
import { buildChatRows, type ChatRow } from '../model/rows';
import type { ChatMessageView, ChatTransport } from '../transport/types';

function mergeReceiptMaps(
  current: Record<string, MessageReceipt[]>,
  incoming: MessageReceipt[],
): Record<string, MessageReceipt[]> {
  const next = { ...current };
  for (const receipt of incoming) {
    const list = (next[receipt.messageId] ?? []).filter(
      (existing) => existing.userId !== receipt.userId,
    );
    list.push(receipt);
    next[receipt.messageId] = list;
  }
  return next;
}

/**
 * État des messages d'un transport : instantané initial, abonnements, index
 * incrémental et rangées. La saisie ne passe pas par ce hook, donc une frappe
 * ne re-rend pas la liste.
 */
export function useChatMessages(input: {
  transport: ChatTransport | null;
  timeGapMs: number;
  unreadFrom?: { id: string; count: number } | null;
}): {
  messages: ChatMessageView[];
  rows: ChatRow[];
  receipts: Record<string, MessageReceipt[]>;
  ready: boolean;
  hasMore: boolean;
  error: string | null;
  loadOlder: () => Promise<void>;
} {
  const { transport, timeGapMs, unreadFrom = null } = input;
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [receipts, setReceipts] = useState<Record<string, MessageReceipt[]>>({});
  const [ready, setReady] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const indexRef = useRef(new MessageIndex<ChatMessageView>());

  useEffect(() => {
    if (!transport) {
      return;
    }
    let active = true;
    indexRef.current = new MessageIndex<ChatMessageView>();

    const publish = () => {
      if (active) setMessages([...indexRef.current.values()]);
    };

    void transport
      .loadInitial()
      .then((snapshot) => {
        if (!active) return;
        indexRef.current = new MessageIndex(snapshot.messages);
        setMessages([...indexRef.current.values()]);
        setReceipts(snapshot.receipts);
        setHasMore(snapshot.hasMore);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : null);
      })
      .finally(() => {
        if (active) setReady(true);
      });

    const off = transport.subscribe({
      onMessage: (message) => {
        indexRef.current.upsert(message);
        publish();
      },
      onMessageRemoved: (id, forEveryone) => {
        const existing = indexRef.current.get(id);
        if (!existing) return;
        if (forEveryone) {
          indexRef.current.upsert({ ...existing, deleted: true, body: '', attachment: null });
        } else {
          indexRef.current.remove(id);
        }
        publish();
      },
      onReceipts: (rows) => {
        if (active) setReceipts((current) => mergeReceiptMaps(current, rows));
      },
      onReaction: (id, reactions) => {
        const existing = indexRef.current.get(id);
        if (!existing) return;
        indexRef.current.upsert({ ...existing, reactions });
        publish();
      },
      onTyping: () => undefined,
      onConnection: () => undefined,
      onConversationUpdated: () => undefined,
      onConversationRemoved: () => undefined,
      onError: (message) => {
        if (active) setError(message);
      },
      onFatal: () => undefined,
    });

    return () => {
      active = false;
      off();
    };
  }, [transport]);

  const loadOlder = useCallback(async () => {
    if (!transport || !hasMore || messages.length === 0) return;
    const oldest = messages[0];
    const page = await transport.loadOlder(oldest.createdAt);
    for (const message of page.messages) {
      indexRef.current.upsert(message);
    }
    setMessages([...indexRef.current.values()]);
    setHasMore(page.hasMore);
  }, [transport, hasMore, messages]);

  const rows = useMemo(
    () => buildChatRows({ messages, timeGapMs, unreadFrom }),
    [messages, timeGapMs, unreadFrom],
  );

  return { messages, rows, receipts, ready, hasMore, error, loadOlder };
}
