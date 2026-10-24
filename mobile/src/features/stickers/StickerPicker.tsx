import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import {
  STICKER_CATEGORIES,
  STICKERS,
  findStickers,
  type Sticker,
  type StickerCategoryId,
} from './sticker-catalog';
import { StickerGrid } from './StickerGrid';
import { createPersonalSticker } from './sticker-service';
import {
  addRecentSticker,
  getStickerLibrary,
  loadStickerLibrary,
  personalToSticker,
  removePersonalSticker,
  subscribeStickerLibrary,
  toggleStickerFavorite,
  type StickerLibraryState,
} from './sticker-store';

type Filter = 'all' | 'recents' | 'favorites' | 'personnels' | StickerCategoryId;

interface FilterChip {
  id: Filter;
  label: string;
}

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

export interface StickerPickerProps {
  onSend: (sticker: Sticker) => void;
}

/**
 * Sélecteur de stickers local : catalogue embarqué, favoris, récents et
 * créations personnelles. Aucun appel réseau n'est nécessaire pour parcourir
 * ou prévisualiser les packs.
 */
export function StickerPicker({ onSend }: StickerPickerProps) {
  const chat = useChatColors();
  const [library, setLibrary] = useState<StickerLibraryState>(() => getStickerLibrary());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);

  const retry = useCallback(() => {
    setLoadError(false);
    setLoading(true);
    loadStickerLibrary()
      .then((state) => {
        setLibrary(state);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let alive = true;
    loadStickerLibrary()
      .then((state) => {
        if (!alive) return;
        setLibrary(state);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setLoadError(true);
        setLoading(false);
      });
    const unsubscribe = subscribeStickerLibrary(() => {
      if (alive) setLibrary(getStickerLibrary());
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const personal = useMemo(() => library.personal.map(personalToSticker), [library.personal]);
  const all = useMemo(() => [...STICKERS, ...personal], [personal]);
  const byId = useMemo(() => new Map(all.map((sticker) => [sticker.id, sticker])), [all]);
  const favorites = useMemo(() => new Set(library.favorites), [library.favorites]);

  const chips = useMemo<FilterChip[]>(
    () => [
      { id: 'all', label: 'Tous' },
      { id: 'recents', label: 'Récents' },
      { id: 'favorites', label: 'Favoris' },
      {
        id: 'personnels',
        label: library.personal.length > 0 ? `Mes stickers · ${library.personal.length}` : 'Mes stickers',
      },
      ...STICKER_CATEGORIES.map((category) => ({
        id: category.id as Filter,
        label: category.label,
      })),
    ],
    [library.personal.length],
  );

  const visible = useMemo(() => {
    const needle = query.trim();
    if (needle) {
      return findStickers(needle, 100, all);
    }
    switch (filter) {
      case 'recents':
        return library.recents
          .map((id) => byId.get(id))
          .filter((sticker): sticker is Sticker => sticker !== undefined);
      case 'favorites':
        return library.favorites
          .map((id) => byId.get(id))
          .filter((sticker): sticker is Sticker => sticker !== undefined);
      case 'personnels':
        return personal;
      case 'expressions':
      case 'animaux':
      case 'reactions':
        return all.filter((sticker) => sticker.category === filter);
      default:
        return all;
    }
  }, [query, filter, all, byId, library.recents, library.favorites, personal]);

  const send = useCallback(
    (sticker: Sticker) => {
      void hapticSelection();
      onSend(sticker);
      void addRecentSticker(sticker.id).catch(() => undefined);
    },
    [onSend],
  );

  const toggleFavorite = useCallback(
    (sticker: Sticker) => {
      void toggleStickerFavorite(sticker.id)
        .then(() => hapticSelection())
        .catch(() => Alert.alert('Favoris indisponibles', "Impossible d'enregistrer ce favori."));
    },
    [],
  );

  const removePersonal = useCallback((sticker: Sticker) => {
    Alert.alert(
      'Supprimer ce sticker ?',
      'Le retirer de « Mes stickers » le retirera aussi de cet appareil.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            void removePersonalSticker(sticker.id).catch(() =>
              Alert.alert('Suppression impossible', 'Réessaie dans un instant.'),
            );
          },
        },
      ],
    );
  }, []);

  const handleLongPress = useCallback(
    (sticker: Sticker) => {
      if (sticker.category !== 'personnels') {
        toggleFavorite(sticker);
        return;
      }
      Alert.alert(sticker.name, undefined, [
        {
          text: favorites.has(sticker.id) ? 'Retirer des favoris' : 'Ajouter aux favoris',
          onPress: () => toggleFavorite(sticker),
        },
        { text: 'Supprimer le sticker', style: 'destructive', onPress: () => removePersonal(sticker) },
        { text: 'Annuler', style: 'cancel' },
      ]);
    },
    [favorites, removePersonal, toggleFavorite],
  );

  const create = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const result = await createPersonalSticker();
      if (result.status === 'created') {
        setQuery('');
        setFilter('personnels');
        void hapticSelection();
      } else if (result.status === 'rejected') {
        Alert.alert('Sticker ignoré', result.reason);
      }
    } catch (error) {
      Alert.alert(
        'Création impossible',
        error instanceof Error ? error.message : 'Impossible de créer ce sticker.',
      );
    } finally {
      setCreating(false);
    }
  }, [creating]);

  const empty = useMemo(() => {
    const needle = query.trim();
    if (needle) {
      return (
        <EmptyState
          icon="search-outline"
          title={`Aucun sticker pour « ${needle} »`}
          hint="Essaie « rire », « chat » ou « merci »."
        />
      );
    }
    switch (filter) {
      case 'recents':
        return (
          <EmptyState
            icon="time-outline"
            title="Aucun sticker récent"
            hint="Les stickers envoyés apparaîtront ici."
          />
        );
      case 'favorites':
        return (
          <EmptyState
            icon="star-outline"
            title="Aucun favori"
            hint="Appui long sur un sticker pour l’ajouter aux favoris."
          />
        );
      case 'personnels':
        return (
          <EmptyState
            icon="images-outline"
            title="Crée ton premier sticker"
            hint="Choisis une photo : le recadrage carré est celui du système."
            action={
              <Pressable
                onPress={() => void create()}
                disabled={creating}
                style={[styles.emptyAction, { backgroundColor: chat.mineBubble }]}
                accessibilityRole="button"
                accessibilityLabel="Créer un sticker depuis la galerie">
                {creating ? (
                  <ActivityIndicator size="small" color={chat.mineText} />
                ) : (
                  <Ionicons name="add" size={17} color={chat.mineText} />
                )}
                <ThemedText type="smallBold" style={{ color: chat.mineText }}>
                  Choisir une photo
                </ThemedText>
              </Pressable>
            }
          />
        );
      default:
        return (
          <EmptyState
            icon="sparkles-outline"
            title="Aucun sticker"
            hint="Le catalogue local est vide pour cette catégorie."
          />
        );
    }
  }, [query, filter, creating, create, chat]);

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <View style={[styles.searchField, { backgroundColor: chat.input }]}>
          <Ionicons name="search" size={16} color={chat.secondaryText} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Rechercher un sticker"
            placeholderTextColor={chat.inputPlaceholder}
            style={[styles.searchInput, { color: chat.primaryText }]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Rechercher un sticker"
          />
          {query ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Vider la recherche">
              <Ionicons name="close-circle" size={17} color={chat.secondaryText} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => void create()}
          disabled={creating}
          style={({ pressed }) => [
            styles.createButton,
            { backgroundColor: chat.mineBubble },
            (pressed || creating) && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Créer un sticker depuis la galerie">
          {creating ? (
            <ActivityIndicator size="small" color={chat.mineText} />
          ) : (
            <Ionicons name="add" size={18} color={chat.mineText} />
          )}
          <ThemedText type="smallBold" style={{ color: chat.mineText }}>
            Créer
          </ThemedText>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.chipScroll}
        contentContainerStyle={styles.chipList}>
        {chips.map((chip) => {
          const active = !query.trim() && filter === chip.id;
          return (
            <Pressable
              key={chip.id}
              onPress={() => {
                setQuery('');
                setFilter(chip.id);
              }}
              style={({ pressed }) => [
                styles.chip,
                { backgroundColor: active ? chat.mineBubble : chat.theirBubble },
                pressed && styles.pressed,
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={chip.label}>
              <ThemedText
                type="small"
                style={{ color: active ? chat.mineText : chat.secondaryText }}>
                {chip.label}
              </ThemedText>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={chat.mineBubble} />
          <ThemedText type="small" style={{ color: chat.secondaryText }}>
            Chargement des stickers…
          </ThemedText>
        </View>
      ) : loadError ? (
        <View style={styles.centerState}>
          <Ionicons name="cloud-offline-outline" size={28} color={chat.inputPlaceholder} />
          <ThemedText type="small" style={{ color: chat.secondaryText, textAlign: 'center' }}>
            Impossible de lire la bibliothèque locale.
          </ThemedText>
          <Pressable
            onPress={retry}
            style={[styles.retry, { backgroundColor: chat.theirBubble }]}
            accessibilityRole="button"
            accessibilityLabel="Réessayer de charger les stickers">
            <ThemedText type="smallBold" style={{ color: chat.primaryText }}>
              Réessayer
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        <StickerGrid
          stickers={visible}
          favorites={favorites}
          onSend={send}
          onToggleFavorite={handleLongPress}
          contentContainerStyle={visible.length === 0 ? styles.emptyContent : styles.gridContent}
          empty={empty}
        />
      )}
    </View>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  const chat = useChatColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: chat.theirBubble }]}>
        <Ionicons name={icon} size={24} color={chat.secondaryText} />
      </View>
      <ThemedText type="smallBold" style={{ color: chat.primaryText, textAlign: 'center' }}>
        {title}
      </ThemedText>
      <ThemedText type="small" style={[styles.emptyHint, { color: chat.secondaryText }]}>
        {hint}
      </ThemedText>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  searchField: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  searchInput: {
    flex: 1,
    height: 36,
    fontSize: 14,
    paddingVertical: 0,
  },
  createButton: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  chipScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipList: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pressed: {
    opacity: 0.62,
  },
  gridContent: {
    paddingBottom: Spacing.three,
  },
  emptyContent: {
    flexGrow: 1,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
  },
  retry: {
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  empty: {
    flex: 1,
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
  },
  emptyIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  emptyHint: {
    textAlign: 'center',
    lineHeight: 18,
  },
  emptyAction: {
    marginTop: Spacing.two,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
});
