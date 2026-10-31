import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';

import type { RecentGif } from '../media/GifPanel';
import { GifPanel } from '../media/GifPanel';
import { StickerPanel } from '../stickers/StickerPanel';
import type { PersonalSticker } from '../stickers/stickerLibrary';
import { EmojiPanel, type PanelTheme } from './EmojiPanel';
import { Radii } from '@/constants/theme';

export type { PanelTheme };

export type ExpressionSection = 'emoji' | 'stickers' | 'gif';

type Props = {
  /** Hauteur totale du panneau (hors marge basse de sécurité). */
  height: number;
  recents: string[];
  favorites: string[];
  onPickEmoji: (emoji: string) => void;
  onBackspace: () => void;
  /** Référence de catalogue à envoyer comme message sticker. */
  onSendSticker: (ref: string) => void;
  onSendPersonalSticker: (sticker: PersonalSticker) => void;
  gifItems: RecentGif[];
  onSendGif: (gif: RecentGif) => void;
  theme: PanelTheme;
  onToggleFavorite?: (emoji: string) => void;
  onSearchFocusChange?: (focused: boolean) => void;
};

const TAB_H = 48;

/**
 * Panneau d'expressions à trois sections explicites : emojis MboloChat,
 * stickers (panthère + créations personnelles) et GIF réutilisables de la
 * conversation. Les ressources et la logique de chaque section restent
 * indépendantes.
 */
export function EmojiStickerPanel({
  height,
  recents,
  favorites,
  onPickEmoji,
  onBackspace,
  onSendSticker,
  onSendPersonalSticker,
  gifItems,
  onSendGif,
  theme,
  onToggleFavorite,
  onSearchFocusChange,
}: Props) {
  const [section, setSection] = useState<ExpressionSection>('emoji');
  const contentHeight = Math.max(80, height - TAB_H);

  const changeSection = useCallback(
    (next: ExpressionSection) => {
      if (next === section) return;
      Keyboard.dismiss();
      onSearchFocusChange?.(false);
      setSection(next);
    },
    [onSearchFocusChange, section],
  );

  return (
    <View style={{ height, backgroundColor: theme.panelBg }}>
      <View
        style={[
          styles.primaryBar,
          { backgroundColor: theme.panelBg, borderBottomColor: theme.border },
        ]}>
        <SectionTab
          label="Emojis Mbolo"
          accessibilityLabel="Emojis MboloChat"
          icon="emoticon-happy-outline"
          active={section === 'emoji'}
          theme={theme}
          onPress={() => changeSection('emoji')}
        />
        <SectionTab
          label="Stickers"
          icon="sticker-emoji"
          active={section === 'stickers'}
          theme={theme}
          onPress={() => changeSection('stickers')}
        />
        <SectionTab
          label="GIF"
          icon="file-gif-box"
          active={section === 'gif'}
          theme={theme}
          onPress={() => changeSection('gif')}
        />
      </View>

      {section === 'emoji' ? (
        <EmojiPanel
          height={contentHeight}
          recents={recents}
          favorites={favorites}
          onPickEmoji={onPickEmoji}
          onBackspace={onBackspace}
          theme={theme}
          onToggleFavorite={onToggleFavorite}
          onSearchFocusChange={onSearchFocusChange}
        />
      ) : section === 'stickers' ? (
        <StickerPanel
          height={contentHeight}
          theme={theme}
          onSendRef={onSendSticker}
          onSendPersonal={onSendPersonalSticker}
          onSearchFocusChange={onSearchFocusChange}
        />
      ) : (
        <GifPanel
          height={contentHeight}
          theme={theme}
          items={gifItems}
          onSend={onSendGif}
          onSearchFocusChange={onSearchFocusChange}
        />
      )}
    </View>
  );
}

type SectionTabProps = {
  label: string;
  accessibilityLabel?: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  active: boolean;
  theme: PanelTheme;
  onPress: () => void;
};

function SectionTab({
  label,
  accessibilityLabel,
  icon,
  active,
  theme,
  onPress,
}: SectionTabProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        styles.tab,
        { backgroundColor: active ? theme.tabActiveBg : 'transparent' },
        active && { borderColor: theme.accent },
      ]}>
      <MaterialCommunityIcons
        name={icon}
        size={20}
        color={active ? theme.accent : theme.subtle}
      />
      <Text
        numberOfLines={1}
        style={[
          styles.tabLabel,
          { color: active ? theme.accent : theme.subtle },
          active && styles.tabLabelActive,
        ]}>
        {label}
      </Text>
      {active ? <View style={[styles.activeLine, { backgroundColor: theme.accent }]} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primaryBar: {
    height: TAB_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    height: 36,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    position: 'relative',
  },
  tabLabel: { fontSize: 12 },
  tabLabelActive: { fontWeight: '700' },
  activeLine: {
    position: 'absolute',
    bottom: 2,
    width: 18,
    height: 2,
    borderRadius: Radii.full,
  },
});
