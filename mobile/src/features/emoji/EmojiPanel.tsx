import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { EMOJI_GROUPS, entriesInGroup, searchEmojis } from './emoji-catalog';
import { pushRecent } from './emoji-history';
import { getEmojiStore } from './emoji-store';
import { toneVariant } from './emoji-text';

/** Vibration légère facultative : un build sans ExpoHaptics ne doit pas planter. */
async function hapticSelection(): Promise<void> {
  try {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    if (!requireOptionalNativeModule('ExpoHaptics')) {
      return;
    }
    const Haptics = await import('expo-haptics');
    await Haptics.selectionAsync();
  } catch {
    // L'accessoire tactile est cosmétique : on laisse commencer.
  }
}

/** Onglet : récents, favoris, ou l'identifiant d'un groupe du catalogue. */
type Tab = 'recents' | 'favorites' | number;

/** Ton 0 = naturel, puis clair → foncé. */
const TONE_COLORS = ['#F9D873', '#F4C89C', '#D8A672', '#B47F4E', '#7C5027'];

const MIN_PANEL_HEIGHT = 280;
const MAX_PANEL_HEIGHT = 348;
/** Largeur cible d'une case du grille : les colonnes suivent l'écran. */
const CELL_TARGET = 44;
const MAX_COLUMNS = 10;

interface EmojiPanelProps {
  /** Le glyphe va dans le champ de texte, à la position du curseur. */
  onSelect: (glyph: string) => void;
  /** Efface une grappe Unicode complète avant le curseur. */
  onBackspace: () => void;
  /** Rendu dans le panneau d'expression unifié : pas de hauteur ni de bordure. */
  embedded?: boolean;
}

export const EmojiPanel = memo(function EmojiPanel({
  onSelect,
  onBackspace,
  embedded = false,
}: EmojiPanelProps) {
  const chat = useChatColors();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('recents');
  const [tone, setTone] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;
    void getEmojiStore()
      .then(async (store) => {
        const [recentsList, favoritesList, toneSaved] = await Promise.all([
          store.loadRecents(),
          store.loadFavorites(),
          store.loadTone(),
        ]);
        if (!mounted) return;
        setRecents(recentsList);
        setFavorites(favoritesList);
        setTone(toneSaved);
        // Sans historique, la grille s'ouvre sur la première catégorie.
        setTab((current) => (current === 'recents' && recentsList.length === 0 ? 0 : current));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const columns = useMemo(() => {
    const usable = windowWidth - Spacing.three * 2 - 96; // place du ton et du ⌫
    return Math.min(MAX_COLUMNS, Math.max(6, Math.floor(usable / CELL_TARGET)));
  }, [windowWidth]);

  const cellSize = Math.floor((windowWidth - Spacing.three * 2) / columns);
  const panelHeight = Math.max(
    MIN_PANEL_HEIGHT,
    Math.min(MAX_PANEL_HEIGHT, Math.round(windowHeight * 0.38)),
  );

  /** Recherche synchrone : filtrer ~1 900 libellés pliés est trivial. */
  const results = useMemo(() => (query.trim() ? searchEmojis(query) : null), [query]);

  const gridGlyphs = useMemo(() => {
    if (results) return results.map((entry) => toneVariant(entry, tone));
    if (tab === 'recents') return recents;
    if (tab === 'favorites') return favorites;
    return entriesInGroup(tab).map((entry) => toneVariant(entry, tone));
  }, [results, tab, recents, favorites, tone]);

  const emptyHint = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed) return results && results.length === 0 ? `Aucun émoji pour « ${trimmed} »` : '';
    if (tab === 'recents') return 'Vos émojis utilisés apparaîtront ici.';
    if (tab === 'favorites') return 'Appui long sur un émoji pour l’ajouter aux favoris.';
    return '';
  }, [results, tab, query]);

  const choose = useCallback(
    (glyph: string) => {
      onSelect(glyph);
      setRecents((current) => pushRecent(current, glyph));
      void getEmojiStore()
        .then((store) => store.addRecent(glyph))
        .catch(() => undefined);
    },
    [onSelect],
  );

  const toggleFavorite = useCallback((glyph: string) => {
    void getEmojiStore()
      .then(async (store) => {
        // L'état ne change qu'après la confirmation du store : la grille et la
        // persistance restent d'accord même si l'écriture rame.
        const added = await store.toggleFavorite(glyph);
        setFavorites((current) =>
          added ? [...current, glyph] : current.filter((item) => item !== glyph),
        );
        return added;
      })
      .catch(() => undefined);
    void hapticSelection();
  }, []);

  const cycleTone = useCallback(() => {
    const next = (tone + 1) % (TONE_COLORS.length + 1);
    setTone(next);
    void getEmojiStore()
      .then((store) => store.setTone(next))
      .catch(() => undefined);
  }, [tone]);

  const body = (
    <>
      <View style={[styles.searchRow, { borderBottomColor: chat.border }]}>
        <Ionicons name="search" size={16} color={chat.secondaryText} style={styles.searchIcon} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Rechercher un émoji"
          placeholderTextColor={chat.inputPlaceholder}
          style={[styles.searchField, { backgroundColor: chat.input, color: chat.primaryText }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Rechercher un émoji"
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            hitSlop={8}
            style={styles.clearQuery}
            accessibilityRole="button"
            accessibilityLabel="Vider la recherche">
            <Ionicons name="close-circle" size={17} color={chat.secondaryText} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.gridWrap}>
        {gridGlyphs.length === 0 && emptyHint ? (
          <View style={styles.hint}>
            <ThemedText type="small" style={{ color: chat.secondaryText }}>
              {emptyHint}
            </ThemedText>
          </View>
        ) : (
          <EmojiGrid
            glyphs={gridGlyphs}
            columns={columns}
            cellSize={cellSize}
            favorites={favorites}
            onChoose={choose}
            onToggleFavorite={toggleFavorite}
          />
        )}
      </View>

      <View style={[styles.tabRow, { borderTopColor: chat.border }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.tabScroll}
          contentContainerStyle={styles.tabList}>
          <CategoryTab
            glyph="🕘"
            active={recents.length > 0 && tab === 'recents'}
            disabled={recents.length === 0}
            background={chat.theirBubble}
            border={chat.border}
            label="Récents"
            onPress={() => setTab('recents')}
          />
          <CategoryTab
            glyph="⭐"
            active={tab === 'favorites'}
            disabled={favorites.length === 0}
            background={chat.theirBubble}
            border={chat.border}
            label="Favoris"
            onPress={() => setTab('favorites')}
          />
          {EMOJI_GROUPS.map((group) => (
            <CategoryTab
              key={group.id}
              glyph={group.glyph}
              active={query === '' && tab === group.id}
              background={chat.theirBubble}
              border={chat.border}
              label={group.label}
              onPress={() => {
                setQuery('');
                setTab(group.id);
              }}
            />
          ))}
        </ScrollView>
        <Pressable
          onPress={cycleTone}
          style={styles.toneButton}
          accessibilityRole="button"
          accessibilityLabel="Changer le ton de peau affiché">
          <Ionicons name="color-fill-outline" size={20} color={chat.secondaryText} />
          <View
            style={[
              styles.toneDot,
              { backgroundColor: tone === 0 ? 'transparent' : TONE_COLORS[Math.min(tone - 1, TONE_COLORS.length - 1)] },
              tone === 0 && styles.toneDotNatural,
            ]}
          />
        </Pressable>
        <Pressable
          onPress={onBackspace}
          style={({ pressed }) => [styles.backspace, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Effacer l’émoji précédent">
          <Ionicons name="backspace-outline" size={22} color={chat.primaryText} />
        </Pressable>
      </View>
    </>
  );

  if (embedded) {
    return (
      <View style={[styles.panel, styles.embedded, { backgroundColor: chat.composer }]}>
        {body}
      </View>
    );
  }

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(180)}
      style={[
        styles.panel,
        {
          backgroundColor: chat.composer,
          height: panelHeight,
          paddingBottom: Math.max(insets.bottom, Spacing.three),
        },
      ]}>
      {body}
    </Animated.View>
  );
});

// ————— Grille virtuelle, rows memoisées —————

interface EmojiGridProps {
  glyphs: string[];
  columns: number;
  cellSize: number;
  favorites: string[];
  onChoose: (glyph: string) => void;
  onToggleFavorite: (glyph: string) => void;
}

type GridRow = { glyphs: string[]; key: number };

const EmojiGrid = memo(function EmojiGrid({
  glyphs,
  columns,
  cellSize,
  favorites,
  onChoose,
  onToggleFavorite,
}: EmojiGridProps) {
  const rows = useMemo<GridRow[]>(() => {
    const chunks: GridRow[] = [];
    for (let i = 0; i < glyphs.length; i += columns) {
      chunks.push({ glyphs: glyphs.slice(i, i + columns), key: i / columns });
    }
    return chunks;
  }, [glyphs, columns]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const renderItem = useCallback(
    ({ item }: { item: GridRow }) => (
      <View style={[styles.row, { height: cellSize }]}>
        {item.glyphs.map((glyph, index) => (
          <GridCell
            key={`${glyph}-${item.key}-${index}`}
            glyph={glyph}
            favorite={favoriteSet.has(glyph)}
            size={cellSize}
            onChoose={onChoose}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
        {/* Dernière rangée incomplète : l'alignement reste calé, sans case morte. */}
        {item.glyphs.length < columns
          ? Array.from({ length: columns - item.glyphs.length }, (_, fill) => (
              <View
                key={`fill-${item.key}-${fill}`}
                style={[styles.cell, { width: cellSize, height: cellSize, opacity: 0 }]}
              />
            ))
          : null}
      </View>
    ),
    [cellSize, columns, favoriteSet, onChoose, onToggleFavorite],
  );

  return (
    <FlatList
      data={rows}
      keyExtractor={(item) => String(item.key)}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      removeClippedSubviews
      initialNumToRender={24}
      windowSize={7}
      renderItem={renderItem}
      extraData={favoriteSet}
      style={styles.gridList}
    />
  );
});

interface CategoryTabProps {
  glyph: string;
  active: boolean;
  disabled?: boolean;
  background: string;
  border: string;
  label: string;
  onPress: () => void;
}

const CategoryTab = memo(function CategoryTab({
  glyph,
  active,
  disabled,
  background,
  border,
  label,
  onPress,
}: CategoryTabProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.tab,
        { backgroundColor: active ? background : 'transparent', borderWidth: active ? 1 : 0, borderColor: border },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={label}>
      <Text style={styles.tabGlyph}>{glyph}</Text>
    </Pressable>
  );
});

interface GridCellProps {
  glyph: string;
  favorite: boolean;
  size: number;
  onChoose: (glyph: string) => void;
  onToggleFavorite: (glyph: string) => void;
}

const GridCell = memo(function GridCell({
  glyph,
  favorite,
  size,
  onChoose,
  onToggleFavorite,
}: GridCellProps) {
  return (
    <Pressable
      onPress={() => onChoose(glyph)}
      onLongPress={() => onToggleFavorite(glyph)}
      style={({ pressed }) => [styles.cell, { width: size, height: size }, pressed && styles.cellPressed]}
      accessibilityRole="button"
      accessibilityLabel={glyph}>
      <Text style={styles.glyph}>{glyph}</Text>
      {favorite ? <View style={styles.favoriteDot} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  embedded: {
    flex: 1,
    borderTopWidth: 0,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchIcon: {
    marginRight: Spacing.two,
  },
  searchField: {
    flex: 1,
    height: 34,
    borderRadius: 17,
    fontSize: 14,
    paddingHorizontal: 12,
  },
  clearQuery: {
    padding: Spacing.two,
    position: 'absolute',
    right: Spacing.three,
  },
  gridWrap: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  gridList: {
    flex: 1,
    minHeight: 0,
  },
  hint: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  row: {
    flexDirection: 'row',
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  glyph: {
    fontSize: 27,
  },
  cellPressed: {
    opacity: 0.35,
  },
  favoriteDot: {
    position: 'absolute',
    bottom: 5,
    right: 7,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#3c87f7',
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.one,
  },
  tabScroll: {
    flex: 1,
  },
  tabList: {
    alignItems: 'center',
    paddingHorizontal: Spacing.one,
    gap: Spacing.one,
  },
  tab: {
    width: 37,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    marginRight: Spacing.one,
  },
  tabGlyph: {
    fontSize: 21,
  },
  disabled: {
    opacity: 0.35,
  },
  toneButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 32,
    borderRadius: 8,
    marginRight: Spacing.one,
  },
  toneDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  toneDotNatural: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.6)',
  },
  backspace: {
    width: 38,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    marginRight: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
});
