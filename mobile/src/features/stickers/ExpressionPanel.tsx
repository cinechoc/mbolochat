import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { EmojiPanel } from '@/features/emoji/EmojiPanel';
import { GiphyPanel } from '@/features/giphy/GiphyPanel';
import { StickerPicker } from './StickerPicker';
import type { Sticker } from './sticker-catalog';
import type { GifSendPayload } from '@/lib/types';

export type ExpressionTab = 'stickers' | 'emoji' | 'gif';

interface ExpressionPanelProps {
  tab: ExpressionTab;
  onChangeTab: (tab: ExpressionTab) => void;
  /** Sans clé GIPHY configurée, l'onglet GIF n'existe pas. */
  giphyEnabled: boolean;
  /**
   * Plafond calculé par l'écran à partir de l'espace réellement disponible
   * (clavier, composeur et barre de réponse déduits).
   */
  maxHeight?: number;
  /** Clavier ouvert : le bas est déjà occupé, l'inset de navigation est inutile. */
  compactBottom?: boolean;
  onSelectEmoji: (glyph: string) => void;
  onBackspace: () => void;
  onSendSticker: (sticker: Sticker) => void;
  onSendGif: (gif: GifSendPayload) => void;
  customerId?: string;
  giphyApiKey?: string;
}

/**
 * Panneau d'expression unique : stickers locaux, émojis et GIF. Un seul endroit
 * pour tout ce qui s'insère dans un message, avec des onglets prévisibles.
 */
export const ExpressionPanel = memo(function ExpressionPanel({
  tab,
  onChangeTab,
  giphyEnabled,
  maxHeight,
  compactBottom = false,
  onSelectEmoji,
  onBackspace,
  onSendSticker,
  onSendGif,
  customerId,
  giphyApiKey,
}: ExpressionPanelProps) {
  const chat = useChatColors();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  /** Ouvert au-dessus du clavier fermé : le panneau peut prendre plus de place. */
  const preferredHeight = Math.max(320, Math.min(420, Math.round(windowHeight * 0.46)));
  const height =
    maxHeight !== undefined
      ? Math.max(150, Math.min(preferredHeight, maxHeight))
      : preferredHeight;

  return (
    <Animated.View
      entering={FadeInDown.duration(200)}
      exiting={FadeOutDown.duration(150)}
      style={[
        styles.panel,
        {
          backgroundColor: chat.composer,
          borderTopColor: chat.border,
          height,
          paddingBottom: compactBottom ? Spacing.two : Math.max(insets.bottom, Spacing.two),
        },
      ]}>
      <View style={[styles.header, { borderBottomColor: chat.border }]}>
        <ExpressionTabButton
          label="Stickers"
          icon="sparkles-outline"
          active={tab === 'stickers'}
          onPress={() => onChangeTab('stickers')}
        />
        <ExpressionTabButton
          label="Émojis"
          icon="happy-outline"
          active={tab === 'emoji'}
          onPress={() => onChangeTab('emoji')}
        />
        {giphyEnabled ? (
          <ExpressionTabButton
            label="GIF"
            icon="film-outline"
            active={tab === 'gif'}
            onPress={() => onChangeTab('gif')}
          />
        ) : null}
      </View>

      <View style={styles.content}>
        {tab === 'stickers' ? <StickerPicker onSend={onSendSticker} /> : null}
        {tab === 'emoji' ? (
          <EmojiPanel embedded onSelect={onSelectEmoji} onBackspace={onBackspace} />
        ) : null}
        {tab === 'gif' && giphyEnabled ? (
          <GiphyPanel
            embedded
            feedMode="gifs"
            onSend={onSendGif}
            customerId={customerId}
            apiKey={giphyApiKey}
          />
        ) : null}
      </View>
    </Animated.View>
  );
});

function ExpressionTabButton({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  const chat = useChatColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        active ? { backgroundColor: chat.mineBubble } : null,
        pressed && styles.pressed,
      ]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}>
      <Ionicons
        name={icon}
        size={15}
        color={active ? chat.mineText : chat.secondaryText}
      />
      <Text
        style={[
          styles.tabLabel,
          { color: active ? chat.mineText : chat.secondaryText },
          active && styles.tabLabelActive,
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexShrink: 0,
    overflow: 'hidden',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  tabLabel: {
    fontSize: 12.5,
    fontWeight: '500',
  },
  tabLabelActive: {
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.64,
  },
  content: {
    flex: 1,
    paddingTop: Spacing.two,
  },
});
