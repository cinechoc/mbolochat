import {
  BellOff,
  Check,
  CheckCheck,
  FileText,
  Film,
  Image as ImageIcon,
  Mic,
  Pin,
  Sticker,
  Video,
} from 'lucide-react-native';
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
import { PresenceDot } from '@/features/presence/PresenceDot';
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
      <View>
        <Avatar name={title} uri={avatarUri} size={52} />
        {!isGroup && other ? <PresenceDot userId={other.id} /> : null}
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <ThemedText numberOfLines={1} style={[styles.title, unread && styles.bold]}>
            {title}
          </ThemedText>
          {conversation.pinned ? (
            <Pin size={13} strokeWidth={2.4} color={theme.textSecondary} style={styles.icon} />
          ) : null}
          {conversation.muted ? (
            <BellOff size={13} strokeWidth={2.4} color={theme.textSecondary} style={styles.icon} />
          ) : null}
        </View>
        <View style={styles.previewRow}>
          {!typing && preview.mine ? (
            preview.read ? (
              <CheckCheck size={14} strokeWidth={2.4} color={accentColor} />
            ) : (
              <Check size={14} strokeWidth={2.4} color={theme.textSecondary} />
            )
          ) : !typing && conversation.lastMessage?.attachment ? (
            conversation.lastMessage.attachment.type === 'IMAGE' ? (
              <ImageIcon size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment.type === 'VIDEO' ? (
              <Video size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment.type === 'AUDIO' ? (
              <Mic size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment.type === 'GIF' ? (
              <Film size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment.type === 'STICKER' ? (
              <Sticker size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : (
              <FileText size={14} strokeWidth={2.2} color={theme.textSecondary} />
            )
          ) : null}
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={1}
            style={[styles.previewText, unread && styles.bold, typing ? styles.typing : null]}>
            {previewText}
          </ThemedText>
        </View>
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
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  previewText: {
    flexShrink: 1,
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
