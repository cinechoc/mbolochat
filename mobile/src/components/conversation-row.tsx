import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { conversationPreview, conversationTitle, formatListTimestamp } from '@/lib/format';
import type { ConversationSummary } from '@/lib/types';

export interface TypingEntry {
  name: string;
  text: string;
}

interface ConversationRowProps {
  conversation: ConversationSummary;
  currentUserId: string;
  typing?: TypingEntry | null;
  onPress: () => void;
  onLongPress: () => void;
}

function ConversationRowComponent({
  conversation,
  currentUserId,
  typing,
  onPress,
  onLongPress,
}: ConversationRowProps) {
  const theme = useTheme();
  const title = conversationTitle(conversation, currentUserId);
  const isGroup = conversation.type === 'GROUP';
  const unread = conversation.unreadCount > 0;
  const preview = conversationPreview(conversation, currentUserId);
  const other = conversation.members.find((member) => member.id !== currentUserId);
  const avatarUri = isGroup ? null : (other?.avatarUrl ?? null);
  const timestamp = formatListTimestamp(
    conversation.lastMessage?.createdAt ?? conversation.createdAt,
  );

  const previewText = typing
    ? `${isGroup ? `${typing.name} · ` : ''}en train d'écrire : ${typing.text}`
    : preview.text;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.backgroundSelected : theme.background },
      ]}>
      <Avatar name={title} uri={avatarUri} size={52} />
      <ThemedView style={styles.body}>
        <ThemedView style={styles.titleRow}>
          <ThemedText numberOfLines={1} style={[styles.title, unread && styles.bold]}>
            {title}
          </ThemedText>
          {conversation.pinned ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.icon}>
              📌
            </ThemedText>
          ) : null}
          {conversation.muted ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.icon}>
              🔕
            </ThemedText>
          ) : null}
        </ThemedView>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          numberOfLines={1}
          style={[unread && styles.bold, typing ? styles.typing : null]}>
          {previewText}
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.meta}>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={unread ? styles.timeUnread : undefined}>
          {timestamp}
        </ThemedText>
        {unread && !conversation.muted ? (
          <ThemedView style={styles.badge}>
            <ThemedText style={styles.badgeText}>
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </ThemedText>
          </ThemedView>
        ) : null}
      </ThemedView>
    </Pressable>
  );
}

export const ConversationRow = memo(ConversationRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    gap: Spacing.three,
  },
  body: {
    flex: 1,
    gap: Spacing.half,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  title: {
    flexShrink: 1,
    fontWeight: '600',
    fontSize: 16,
    lineHeight: 22,
  },
  icon: {
    fontSize: 12,
  },
  bold: {
    fontWeight: '700',
  },
  typing: {
    fontStyle: 'italic',
  },
  meta: {
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
  timeUnread: {
    color: accentColor,
    fontWeight: '700',
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: accentColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
});
