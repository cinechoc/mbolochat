import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { FlatList } from 'react-native';

import type { ChatRow } from '../model/rows';
import {
  INITIAL_SCROLL_STATE,
  countUnseen,
  resetScrollState,
  scrollStateForOffset,
  type ScrollState,
} from '../model/scroll-state';

/**
 * Défilement unifié (liste inversée dans les deux modes). Les calculs sont
 * dans `scroll-state.ts` ; le hook ne garde que les références et l'état React.
 */
export function useChatScroll(rows: readonly ChatRow[]): {
  listRef: RefObject<FlatList<ChatRow> | null>;
  atBottomRef: MutableRefObject<boolean>;
  showJump: boolean;
  unseen: number;
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
  notifyIncoming: (count: number) => void;
  jumpToBottom: () => void;
  scrollToMessage: (messageId: string) => void;
} {
  const listRef = useRef<FlatList<ChatRow>>(null);
  const atBottomRef = useRef(true);
  const stateRef = useRef<ScrollState>(INITIAL_SCROLL_STATE);
  const [state, setState] = useState<ScrollState>(INITIAL_SCROLL_STATE);

  const commit = useCallback((next: ScrollState) => {
    const previous = stateRef.current;
    if (
      next.atBottom === previous.atBottom &&
      next.showJump === previous.showJump &&
      next.unseen === previous.unseen
    ) {
      return;
    }
    stateRef.current = next;
    atBottomRef.current = next.atBottom;
    setState(next);
  }, []);

  const onScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      commit(scrollStateForOffset(event.nativeEvent.contentOffset.y, stateRef.current.unseen));
    },
    [commit],
  );

  const notifyIncoming = useCallback(
    (count: number) => {
      commit(countUnseen(stateRef.current, count));
    },
    [commit],
  );

  const jumpToBottom = useCallback(() => {
    commit(resetScrollState());
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [commit]);

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

  return {
    listRef,
    atBottomRef,
    showJump: state.showJump,
    unseen: state.unseen,
    onScroll,
    notifyIncoming,
    jumpToBottom,
    scrollToMessage,
  };
}
