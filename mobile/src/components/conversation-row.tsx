import {
  BellOff,
  Check,
  CheckCheck,
  FileText,
  Film,
  Image as ImageIcon,
  Mic,
  Phone,
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

import { Spacing } from '@/constants/theme';
import { EmojiText } from '@/features/emoji/EmojiText';
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
  /** Un appel de groupe est ouvert dans cette discussion. */
  liveCall?: boolean;
  /** Reçoit la conversation : la fonction peut rester stable entre les rendus. */
  onPress: (conversation: ConversationSummary) => void;
  onLongPress: (conversation: ConversationSummary) => void;
}

function ConversationRowComponent({
  conversation,
  currentUserId,
  typing,
  liveCall,
  onPress,
  onLongPress,
}: ConversationRowProps) {
  const theme = useTheme();
  const title = conversationTitle(conversation, currentUserId);
  const isGroup = conversation.type === 'GROUP';
  const unread = conversation.unreadCount > 0;
  const preview = conversationPreview(conversation, currentUserId);
  const other = conversation.members.find((member) => member.id !== currentUserId);
  const avatarUri = isGroup ? (conversation.avatarUrl ?? null) : (other?.avatarUrl ?? null);
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
    ? isGroup
      ? `${typing.name} écrit…`
      : 'En train d’écrire'
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
        <Avatar
          name={title}
          uri={avatarUri}
          size={52}
          gender={isGroup ? null : other?.gender}
          variant={isGroup ? 'group' : 'user'}
          shape="rounded"
          emoji={isGroup ? conversation.emoji : null}
          color={isGroup ? conversation.color : null}
        />
        {!isGroup && other ? <PresenceDot userId={other.id} /> : null}
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <ThemedText numberOfLines={1} style={[styles.title, unread && styles.bold]}>
            {title}
          </ThemedText>
          {liveCall ? (
            <Phone size={13} strokeWidth={2.6} color={theme.accent} style={styles.icon} />
          ) : null}
          {conversation.pinned ? (
            <Pin size={13} strokeWidth={2.4} color={theme.textSecondary} style={styles.icon} />
          ) : null}
          {conversation.muted ? (
            <BellOff size={13} strokeWidth={2.4} color={theme.textSecondary} style={styles.icon} />
          ) : null}
        </View>
        <View style={styles.previewRow}>
          {!typing && conversation.lastMessage?.type === 'call' ? (
            <Phone size={14} strokeWidth={2.2} color={theme.textSecondary} />
          ) : !typing && preview.mine ? (
            preview.read ? (
              <CheckCheck size={14} strokeWidth={2.4} color={theme.accent} />
            ) : (
              <Check size={14} strokeWidth={2.4} color={theme.textSecondary} />
            )
          ) : !typing &&
            (conversation.lastMessage?.type === 'sticker' ||
              conversation.lastMessage?.attachment) ? (
            conversation.lastMessage.type === 'sticker' ? (
              <Sticker size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment?.type === 'IMAGE' ? (
              <ImageIcon size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment?.type === 'VIDEO' ? (
              <Video size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment?.type === 'AUDIO' ? (
              <Mic size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment?.type === 'GIF' ? (
              <Film size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : conversation.lastMessage.attachment?.type === 'STICKER' ? (
              <Sticker size={14} strokeWidth={2.2} color={theme.textSecondary} />
            ) : (
              <FileText size={14} strokeWidth={2.2} color={theme.textSecondary} />
            )
          ) : null}
          <EmojiText
            numberOfLines={1}
            style={[
              styles.previewText,
              { color: typing ? theme.accent : theme.textSecondary },
              unread && styles.bold,
              typing ? styles.typing : null,
            ]}>
            {previewText}
          </EmojiText>
        </View>
      </View>
      <View style={styles.meta}>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={[unread ? styles.timeUnread : undefined, unread ? { color: theme.accent } : null]}>
          {timestamp}
        </ThemedText>
        {unread ? (
          <View
            style={[
              styles.badge,
              { backgroundColor: conversation.muted ? theme.backgroundElement : theme.accent },
            ]}>
            <ThemedText
              style={[
                styles.badgeText,
                conversation.muted ? { color: theme.textSecondary } : null,
              ]}>
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </ThemedText>
          </View>
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
    fontWeight: '700',
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
});
