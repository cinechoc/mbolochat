import { MaterialIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { conversationPreview, conversationTitle, formatListTimestamp } from '@/lib/format';
import type { ConversationSummary } from '@/lib/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface TypingEntry {
  name: string;
  text: string;
}

interface ConversationRowProps {
  conversation: ConversationSummary;
  currentUserId: string;
  typing?: TypingEntry | null;
  /** Reçoit la conversation : la fonction peut rester stable entre les rendus. */
  onPress: (conversation: ConversationSummary) => void;
  onLongPress: (conversation: ConversationSummary) => void;
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

  // Animation de pression : le fond de la ligne glisse vers la couleur de sélection
  // (la ligne reste en pleine largeur, rien ne bouge à l'écran).
  const pressProgress = useSharedValue(0);
  const rowAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressProgress.value,
      [0, 1],
      [theme.background, theme.backgroundSelected],
    ),
  }));

  const previewText = typing
    ? `${isGroup ? `${typing.name} · ` : ''}en train d'écrire : ${typing.text}`
    : preview.text;

  return (
    <AnimatedPressable
      onPress={() => onPress(conversation)}
      onLongPress={() => onLongPress(conversation)}
      delayLongPress={300}
      onPressIn={() => {
        // Pattern Reanimated officiel : on pilote la valeur partagée depuis un handler.
        // Exception au compilateur React qui n'aime pas la mutation (react-hooks/immutability).
        // eslint-disable-next-line react-hooks/immutability
        pressProgress.value = withTiming(1, { duration: 110 });
      }}
      onPressOut={() => {
        // eslint-disable-next-line react-hooks/immutability
        pressProgress.value = withTiming(0, { duration: 160 });
      }}
      style={[styles.row, rowAnimatedStyle]}>
      <Avatar name={title} uri={avatarUri} size={52} />
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <ThemedText numberOfLines={1} style={[styles.title, unread && styles.bold]}>
            {title}
          </ThemedText>
          {conversation.pinned ? (
            <MaterialIcons
              name="push-pin"
              size={13}
              color={theme.textSecondary}
              style={styles.icon}
            />
          ) : null}
          {conversation.muted ? (
            <MaterialIcons
              name="notifications-off"
              size={13}
              color={theme.textSecondary}
              style={styles.icon}
            />
          ) : null}
        </View>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          numberOfLines={1}
          style={[unread && styles.bold, typing ? styles.typing : null]}>
          {previewText}
        </ThemedText>
      </View>
      <View style={styles.meta}>
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
      </View>
    </AnimatedPressable>
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
    marginLeft: 2,
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
