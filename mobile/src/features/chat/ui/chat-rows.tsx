import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useChatColors } from '@/constants/chat-theme';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Gender } from '@/lib/types';
import { messageRowLayout, ROW_AVATAR_SIZE } from '@/features/chat/row-layout';

/**
 * Lignes communes aux deux conversations : séparateurs de date et d'heure,
 * rangée de message (avatar + colonne de bulle). Les mêmes valeurs que l'écran
 * classique, pour que la conversation chiffrée ne « saute » pas d'un pixel.
 */

export function ChatDateSeparator({ label }: { label: string }) {
  const chat = useChatColors();
  const theme = useTheme();
  return (
    <View style={styles.dateRow}>
      <ThemedView
        style={[
          styles.datePill,
          { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        ]}>
        <ThemedText type="micro" style={[styles.dateText, { color: chat.dateText }]}>
          {label}
        </ThemedText>
      </ThemedView>
    </View>
  );
}

export function ChatTimeSeparator({ label }: { label: string }) {
  const chat = useChatColors();
  return (
    <View style={styles.timeRow}>
      <ThemedText style={[styles.timeText, { color: chat.secondaryText }]}>{label}</ThemedText>
    </View>
  );
}

export function ChatMessageRow({
  mine,
  continuation,
  avatarName,
  avatarUri,
  gender,
  onAvatarPress,
  children,
}: {
  mine: boolean;
  /** Message consécutif du même expéditeur : l'avatar n'est pas répété. */
  continuation?: boolean;
  avatarName: string;
  avatarUri?: string | null;
  gender?: Gender | null;
  /** Ouvre le profil de l'expéditeur (messages envoyés : le sien). */
  onAvatarPress?: () => void;
  children: ReactNode;
}) {
  // Disposition WeChat : chaque message porte l'avatar de son expéditeur —
  // à gauche pour les messages reçus, à droite pour les messages envoyés — et
  // la bulle est alignée du même côté. La logique de placement est pure et
  // testée à part (features/chat/row-layout.ts).
  const layout = messageRowLayout(mine, Boolean(continuation));
  const avatar =
    layout.avatar === 'none' ? (
      layout.spacer === 'left' ? (
        <View style={styles.avatarSpacer} />
      ) : null
    ) : (
      <Pressable
        disabled={!onAvatarPress}
        onPress={onAvatarPress}
        hitSlop={4}
        accessibilityRole={onAvatarPress ? 'button' : undefined}
        accessibilityLabel={onAvatarPress ? avatarName : undefined}>
        <Avatar
          name={avatarName}
          uri={avatarUri ?? undefined}
          size={ROW_AVATAR_SIZE}
          gender={gender}
          shape="circle"
        />
      </Pressable>
    );
  const column = (
    <View style={[styles.bubbleColumn, { alignItems: layout.align }]}>{children}</View>
  );
  return (
    <View
      style={[
        styles.messageRow,
        continuation ? styles.messageRowContinuation : styles.messageRowNewGroup,
      ]}>
      {layout.bubbleFirst ? column : avatar}
      {layout.bubbleFirst ? avatar : column}
    </View>
  );
}

export const chatRowStyles = StyleSheet.create({
  dateRow: { alignItems: 'center', paddingVertical: Spacing.two },
  datePill: {
    paddingHorizontal: Spacing.threeHalf,
    paddingVertical: Spacing.one,
    borderRadius: Radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dateText: { fontSize: 11, lineHeight: 14 },
  timeRow: { alignItems: 'center', paddingVertical: Spacing.one },
  timeText: { fontSize: 11, lineHeight: 14 },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  messageRowContinuation: { marginTop: Spacing.one },
  messageRowNewGroup: { marginTop: Spacing.threeHalf },
  bubbleColumn: { flex: 1, minWidth: 0 },
  /** Réserve la place de l'avatar rond des messages reçus consécutifs. */
  avatarSpacer: { width: ROW_AVATAR_SIZE },
});

const styles = chatRowStyles;
