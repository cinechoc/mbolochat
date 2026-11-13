import { useCallback, type ComponentProps, type ReactElement, type RefObject } from 'react';
import { FlatList, StyleSheet } from 'react-native';

import type { ChatRow } from '../model/rows';
import { ChatMessageRow, type ChatMessageRowProps } from './chat-message-row';

type ViewableCallback = NonNullable<
  ComponentProps<typeof FlatList>['onViewableItemsChanged']
>;

export interface ChatMessageListProps extends Omit<ChatMessageRowProps, 'row'> {
  rows: ChatRow[];
  listRef: RefObject<FlatList<ChatRow> | null>;
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
  onEndReached: () => void;
  emptyComponent?: ReactElement | null;
  viewabilityConfig?: { itemVisiblePercentThreshold: number; minimumViewTime: number };
  onViewableItemsChanged?: ViewableCallback;
}

/**
 * Liste inversée unique. Les réglages de fenêtrage sont posés une seule fois ;
 * `renderItem` est stable et ne construit aucun objet ni style par ligne.
 */
export function ChatMessageList({
  rows,
  listRef,
  onScroll,
  onEndReached,
  emptyComponent,
  viewabilityConfig,
  onViewableItemsChanged,
  currentUser,
  isGroup,
  capabilities,
  chat,
  bubbleStyle,
  windowWidth,
  token,
  resolveQuote,
  seenByCountFor,
  onReply,
  onLongPress,
  onRetry,
  onDiscard,
  onOpenMedia,
  onOpenAlbum,
  onToggleReaction,
  onPressAvatar,
  onSeenBy,
}: ChatMessageListProps) {
  const keyExtractor = useCallback((row: ChatRow) => row.key, []);
  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => (
      <ChatMessageRow
        row={item}
        currentUser={currentUser}
        isGroup={isGroup}
        capabilities={capabilities}
        chat={chat}
        bubbleStyle={bubbleStyle}
        windowWidth={windowWidth}
        token={token}
        resolveQuote={resolveQuote}
        seenByCountFor={seenByCountFor}
        onReply={onReply}
        onLongPress={onLongPress}
        onRetry={onRetry}
        onDiscard={onDiscard}
        onOpenMedia={onOpenMedia}
        onOpenAlbum={onOpenAlbum}
        onToggleReaction={onToggleReaction}
        onPressAvatar={onPressAvatar}
        onSeenBy={onSeenBy}
      />
    ),
    [
      currentUser,
      isGroup,
      capabilities,
      chat,
      bubbleStyle,
      windowWidth,
      token,
      resolveQuote,
      seenByCountFor,
      onReply,
      onLongPress,
      onRetry,
      onDiscard,
      onOpenMedia,
      onOpenAlbum,
      onToggleReaction,
      onPressAvatar,
      onSeenBy,
    ],
  );

  return (
    <FlatList
      ref={listRef}
      data={rows}
      inverted
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      onScroll={onScroll}
      scrollEventThrottle={160}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.3}
      initialNumToRender={15}
      maxToRenderPerBatch={10}
      windowSize={5}
      updateCellsBatchingPeriod={50}
      removeClippedSubviews
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      ListEmptyComponent={emptyComponent ?? undefined}
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableItemsChanged}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    flexGrow: 1,
  },
});
