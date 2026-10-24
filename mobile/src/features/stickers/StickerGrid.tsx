import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useMemo } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import type { Sticker } from './sticker-catalog';

const H_PADDING = Spacing.three;
const CELL_TARGET = 82;
const MAX_COLUMNS = 6;
const MIN_COLUMNS = 4;

export interface StickerGridProps {
  stickers: Sticker[];
  favorites: ReadonlySet<string>;
  onSend: (sticker: Sticker) => void;
  onToggleFavorite: (sticker: Sticker) => void;
  contentContainerStyle?: StyleProp<ViewStyle>;
  header?: React.ReactElement;
  empty?: React.ReactElement;
}

type GridRow = { key: number; stickers: Sticker[] };

/**
 * Grille de stickers virtualisée par rangées : une image transparente coûte
 * moins qu'une bulle, mais la liste reste bornée en mémoire sur un gros pack.
 */
export const StickerGrid = memo(function StickerGrid({
  stickers,
  favorites,
  onSend,
  onToggleFavorite,
  contentContainerStyle,
  header,
  empty,
}: StickerGridProps) {
  const { width: windowWidth } = useWindowDimensions();
  const columns = Math.max(
    MIN_COLUMNS,
    Math.min(MAX_COLUMNS, Math.floor((windowWidth - H_PADDING * 2) / CELL_TARGET)),
  );
  const cellSize = Math.floor((windowWidth - H_PADDING * 2) / columns);

  const rows = useMemo<GridRow[]>(() => {
    const chunks: GridRow[] = [];
    for (let index = 0; index < stickers.length; index += columns) {
      chunks.push({ key: index / columns, stickers: stickers.slice(index, index + columns) });
    }
    return chunks;
  }, [stickers, columns]);

  const renderRow = useCallback(
    ({ item }: { item: GridRow }) => (
      <View style={[styles.row, { height: cellSize }]}>
        {item.stickers.map((sticker) => (
          <StickerTile
            key={sticker.id}
            sticker={sticker}
            size={cellSize}
            favorite={favorites.has(sticker.id)}
            onSend={onSend}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
        {item.stickers.length < columns
          ? Array.from({ length: columns - item.stickers.length }, (_, fill) => (
              <View key={`fill-${item.key}-${fill}`} style={{ width: cellSize, height: cellSize }} />
            ))
          : null}
      </View>
    ),
    [cellSize, columns, favorites, onSend, onToggleFavorite],
  );

  return (
    <FlatList
      data={rows}
      key={`sticker-grid-${columns}`}
      keyExtractor={(row) => String(row.key)}
      renderItem={renderRow}
      style={styles.list}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={contentContainerStyle}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={8}
      windowSize={5}
      removeClippedSubviews
      extraData={favorites}
    />
  );
});

interface StickerTileProps {
  sticker: Sticker;
  size: number;
  favorite: boolean;
  onSend: (sticker: Sticker) => void;
  onToggleFavorite: (sticker: Sticker) => void;
}

const StickerTile = memo(function StickerTile({
  sticker,
  size,
  favorite,
  onSend,
  onToggleFavorite,
}: StickerTileProps) {
  const chat = useChatColors();
  return (
    <Pressable
      onPress={() => onSend(sticker)}
      onLongPress={() => onToggleFavorite(sticker)}
      delayLongPress={280}
      style={({ pressed }) => [
        styles.cell,
        { width: size, height: size },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Sticker ${sticker.name}${favorite ? ', favori' : ''}`}
      accessibilityHint="Appui long pour les options">
      <Image
        source={sticker.source}
        style={{ width: size - 18, height: size - 18 }}
        contentFit="contain"
        transition={100}
        recyclingKey={sticker.id}
        accessibilityIgnoresInvertColors
      />
      {favorite ? (
        <View style={[styles.favoriteBadge, { backgroundColor: chat.mineBubble }]}>
          <Ionicons name="star" size={9} color={chat.mineText} />
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  list: {
    flex: 1,
    minHeight: 0,
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: H_PADDING,
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.58,
    transform: [{ scale: 0.94 }],
  },
  favoriteBadge: {
    position: 'absolute',
    right: 9,
    bottom: 7,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
