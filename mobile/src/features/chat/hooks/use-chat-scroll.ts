import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { FlatList } from 'react-native';

import type { ChatRow } from '../model/rows';

/** Au-delà de ce défilement, la pastille de retour en bas apparaît. */
const JUMP_AFTER_PX = 320;

/**
 * Défilement unifié : **liste inversée dans les deux modes** (offset 0 = le
 * dernier message). Le compteur d'invisibles et la pastille de retour sont
 * identiques au clair et au chiffré.
 */
export function useChatScroll(rows: readonly ChatRow[]): {
  listRef: RefObject<FlatList<ChatRow> | null>;
  atBottomRef: MutableRefObject<boolean>;
  showJump: boolean;
  unseen: number;
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
  jumpToBottom: () => void;
  scrollToMessage: (messageId: string) => void;
} {
  const listRef = useRef<FlatList<ChatRow>>(null);
  const atBottomRef = useRef(true);
  const showJumpRef = useRef(false);
  const unseenRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [unseen, setUnseen] = useState(0);

  const onScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      const offset = event.nativeEvent.contentOffset.y;
      atBottomRef.current = offset <= 32;
      const shouldShow = !atBottomRef.current && offset > JUMP_AFTER_PX;
      if (shouldShow !== showJumpRef.current) {
        showJumpRef.current = shouldShow;
        setShowJump(shouldShow);
      }
      if (atBottomRef.current && unseenRef.current > 0) {
        unseenRef.current = 0;
        setUnseen(0);
      }
    },
    [],
  );

  const jumpToBottom = useCallback(() => {
    unseenRef.current = 0;
    setUnseen(0);
    showJumpRef.current = false;
    setShowJump(false);
    atBottomRef.current = true;
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const scrollToMessage = useCallback(
    (messageId: string) => {
      const index = rows.findIndex((row) =>
        row.type === 'message'
          ? row.message.id === messageId
          : row.type === 'album' && row.messages.some((message) => message.id === messageId),
      );
      if (index >= 0) {
        listRef.current?.scrollToIndex({ index, viewPosition: 0.35, animated: true });
      }
    },
    [rows],
  );

  return { listRef, atBottomRef, showJump, unseen, onScroll, jumpToBottom, scrollToMessage };
}
