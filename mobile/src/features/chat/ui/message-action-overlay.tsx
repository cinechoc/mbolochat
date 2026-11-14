import { Plus } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SheetAction } from '@/components/action-sheet';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Radii, Scrim, Spacing } from '@/constants/theme';
import {
  ALL_REACTIONS,
  QUICK_REACTIONS,
  type ReactionPresentation,
} from '@/features/stickers/reactionPresentation';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { ChatMessageView } from '../transport/types';
import { placeFloatingBar, type OverlayAnchor } from './message-overlay-layout';

const REACTION_BUTTON = 36;
const REACTION_GAP = Spacing.one;
const REACTION_PADDING = Spacing.one;
const QUICK_BAR_WIDTH =
  (QUICK_REACTIONS.length + 1) * REACTION_BUTTON +
  QUICK_REACTIONS.length * REACTION_GAP +
  REACTION_PADDING * 2;
const QUICK_BAR_HEIGHT = REACTION_BUTTON + REACTION_PADDING * 2;
const PICKER_BAR_HEIGHT = QUICK_BAR_HEIGHT + 24;

interface MessageActionOverlayProps {
  visible: boolean;
  message: ChatMessageView | null;
  anchor: OverlayAnchor | null;
  canReact: boolean;
  actions: SheetAction[];
  onToggleReaction: (messageId: string, reaction: string) => void;
  onClose: () => void;
}

function ReactionButton({
  reaction,
  onPress,
}: {
  reaction: ReactionPresentation;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={reaction.label}
      style={({ pressed }) => [styles.reactionButton, pressed && styles.pressed]}>
      <ThemedText style={styles.reactionEmoji}>{reaction.emoji}</ThemedText>
    </Pressable>
  );
}

function ActionRow({ action, onClose }: { action: SheetAction; onClose: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        onClose();
        action.onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => [
        styles.action,
        pressed && { backgroundColor: theme.backgroundSelected },
      ]}>
      {action.icon ? (
        <Icon
          icon={action.icon}
          size={20}
          color={action.destructive ? theme.danger : theme.text}
          style={styles.actionIcon}
        />
      ) : null}
      <ThemedText style={action.destructive ? { color: theme.danger } : undefined}>
        {action.label}
      </ThemedText>
    </Pressable>
  );
}

/**
 * Voile d’appui long : il assombrit la conversation, place les réactions
 * juste au-dessus de la bulle et garde les actions dans une carte basse.
 */
export function MessageActionOverlay({
  visible,
  message,
  anchor,
  canReact,
  actions,
  onToggleReaction,
  onClose,
}: MessageActionOverlayProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuHeight, setMenuHeight] = useState(0);
  const close = useCallback(() => {
    setPickerOpen(false);
    onClose();
  }, [onClose]);

  const placement = useMemo(
    () =>
      placeFloatingBar({
        anchor,
        windowWidth: width,
        windowHeight: height,
        safeTop: insets.top,
        barWidth: QUICK_BAR_WIDTH,
        barHeight: pickerOpen ? PICKER_BAR_HEIGHT : QUICK_BAR_HEIGHT,
        menuTop:
          menuHeight > 0
            ? height - insets.bottom - Spacing.two - menuHeight
            : undefined,
      }),
    [anchor, width, height, insets.top, insets.bottom, menuHeight, pickerOpen],
  );

  if (!visible || !message) return null;

  const displayed = pickerOpen ? ALL_REACTIONS : QUICK_REACTIONS;
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}>
      <View style={styles.root}>
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={fr.common.close}
        />
        {canReact ? (
          <View
            style={[
              styles.reactionCard,
              {
                left: placement.left,
                top: placement.top,
                width: QUICK_BAR_WIDTH,
                backgroundColor: theme.backgroundElevated,
                borderColor: theme.border,
              },
            ]}>
            {pickerOpen ? (
              <ThemedText type="micro" themeColor="textSecondary" style={styles.pickerTitle}>
                {fr.chat.unified.reactions.title}
              </ThemedText>
            ) : null}
            <View style={styles.reactionRow}>
              {displayed.map((reaction) => (
                <ReactionButton
                  key={reaction.ref}
                  reaction={reaction}
                  onPress={() => {
                    close();
                    onToggleReaction(message.id, reaction.ref);
                  }}
                />
              ))}
              {!pickerOpen ? (
                <Pressable
                  onPress={() => setPickerOpen(true)}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={fr.chat.unified.reactions.more}
                  style={({ pressed }) => [styles.reactionButton, pressed && styles.pressed]}>
                  <Plus size={20} strokeWidth={2.4} color={theme.textSecondary} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        <View
          accessibilityViewIsModal
          style={[styles.menuWrap, { paddingBottom: insets.bottom + Spacing.two }]}>
          <View
            onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
            style={[
              styles.menuCard,
              { backgroundColor: theme.backgroundElevated, borderColor: theme.border },
            ]}>
            <ThemedText type="smallBold" numberOfLines={1} style={styles.menuTitle}>
              {fr.chat.unified.messageOptions}
            </ThemedText>
            <ScrollView
              style={styles.menuScroll}
              contentContainerStyle={styles.menuScrollContent}
              showsVerticalScrollIndicator={false}>
              {actions.map((action) => (
                <ActionRow key={action.key} action={action} onClose={close} />
              ))}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { backgroundColor: Scrim },
  reactionCard: {
    position: 'absolute',
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: REACTION_PADDING,
    elevation: 14,
  },
  pickerTitle: {
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.one,
    textTransform: 'uppercase',
  },
  reactionRow: { flexDirection: 'row', alignItems: 'center', gap: REACTION_GAP },
  reactionButton: {
    width: REACTION_BUTTON,
    height: REACTION_BUTTON,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionEmoji: { fontSize: 24, lineHeight: 30 },
  menuWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.two,
  },
  menuCard: {
    borderRadius: Radii.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 18,
  },
  menuTitle: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.threeHalf,
    paddingBottom: Spacing.one,
  },
  menuScroll: { maxHeight: 360 },
  menuScrollContent: { paddingBottom: Spacing.one },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  actionIcon: { width: 24 },
  pressed: { opacity: 0.65 },
});
