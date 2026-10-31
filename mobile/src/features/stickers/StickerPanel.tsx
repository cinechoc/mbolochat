import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  useWindowDimensions,
} from 'react-native';

import type { PanelTheme } from '../emoji/EmojiPanel';
import {
  CATALOG_STICKERS,
  entriesForKeys,
  personalEntry,
  searchStickerEntries,
  type StickerEntry,
} from './stickerEntries';
import { pickStickerImage, savePickedSticker, type PickedStickerImage } from './stickerCreation';
import {
  addRecentSticker,
  removePersonalSticker,
  toggleStickerFavorite,
  type PersonalSticker,
} from './stickerLibrary';
import { useStickerLibrary } from './useStickerLibrary';
import { StickerView } from './StickerView';
import { Radii } from '@/constants/theme';

type Filter = 'all' | 'favorites' | 'recents' | 'personal';

type Props = {
  /** Hauteur de la section stickers (barre de recherche incluse). */
  height: number;
  theme: PanelTheme;
  onSendRef: (ref: string) => void;
  onSendPersonal: (sticker: PersonalSticker) => void;
  onSearchFocusChange?: (focused: boolean) => void;
};

const SEARCH_H = 48;
const COLUMNS = 4;
const GRID_PADDING = 6;

function hapticSelection(): void {
  Haptics.selectionAsync().catch(() => undefined);
}

export function StickerPanel({
  height,
  theme,
  onSendRef,
  onSendPersonal,
  onSearchFocusChange,
}: Props) {
  const { width } = useWindowDimensions();
  const library = useStickerLibrary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [searchFocused, setSearchFocused] = useState(false);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<PickedStickerImage | null>(null);
  const listRef = useRef<FlatList<StickerEntry>>(null);
  const searchRef = useRef<TextInputInstance>(null);

  const cellSize = (width - GRID_PADDING * 2) / COLUMNS;
  const artSize = Math.round(cellSize - 14);
  const favorites = useMemo(() => new Set(library.favorites), [library.favorites]);
  const personalEntries = useMemo(
    () => library.personal.map(personalEntry),
    [library.personal],
  );
  const allEntries = useMemo(
    () => [...CATALOG_STICKERS, ...personalEntries],
    [personalEntries],
  );
  const favoriteEntries = useMemo(
    () => entriesForKeys(library.favorites, library),
    [library],
  );
  const recentEntries = useMemo(
    () => entriesForKeys(library.recents, library),
    [library],
  );

  const baseEntries =
    filter === 'favorites'
      ? favoriteEntries
      : filter === 'recents'
        ? recentEntries
        : filter === 'personal'
          ? personalEntries
          : allEntries;
  const visible = useMemo(
    () => searchStickerEntries(baseEntries, query),
    [baseEntries, query],
  );

  const handleSearchFocus = useCallback(() => {
    setSearchFocused(true);
    onSearchFocusChange?.(true);
  }, [onSearchFocusChange]);

  const handleSearchBlur = useCallback(() => {
    setSearchFocused(false);
    onSearchFocusChange?.(false);
  }, [onSearchFocusChange]);

  const chooseFilter = useCallback((next: Filter) => {
    setFilter(next);
    setQuery('');
    void Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const send = useCallback(
    (entry: StickerEntry) => {
      hapticSelection();
      void addRecentSticker(entry.key).catch(() => undefined);
      if (entry.kind === 'catalog') onSendRef(entry.key);
      else onSendPersonal(entry.personal);
    },
    [onSendPersonal, onSendRef],
  );

  const toggleFavorite = useCallback((entry: StickerEntry) => {
    hapticSelection();
    void toggleStickerFavorite(entry.key).catch(() =>
      Alert.alert('Favoris indisponibles', "Impossible d'enregistrer ce favori."),
    );
  }, []);

  const deletePersonal = useCallback((entry: StickerEntry) => {
    if (entry.kind !== 'personal') return;
    Alert.alert(
      'Supprimer ce sticker ?',
      'Le retirer de « Mes stickers » le supprimera aussi de cet appareil.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            void removePersonalSticker(entry.key).catch(() =>
              Alert.alert('Suppression impossible', 'Réessaie dans un instant.'),
            );
          },
        },
      ],
    );
  }, []);

  const openOptions = useCallback(
    (entry: StickerEntry) => {
      if (entry.kind === 'catalog') {
        toggleFavorite(entry);
        return;
      }
      hapticSelection();
      Alert.alert(entry.name, undefined, [
        {
          text: favorites.has(entry.key) ? 'Retirer des favoris' : 'Ajouter aux favoris',
          onPress: () => toggleFavorite(entry),
        },
        {
          text: 'Supprimer le sticker',
          style: 'destructive',
          onPress: () => deletePersonal(entry),
        },
        { text: 'Annuler', style: 'cancel' },
      ]);
    },
    [deletePersonal, favorites, toggleFavorite],
  );

  const beginCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const picked = await pickStickerImage();
      if (picked) setPreview(picked);
    } catch (error) {
      Alert.alert(
        'Création impossible',
        error instanceof Error ? error.message : 'Impossible de choisir cette image.',
      );
    } finally {
      setCreating(false);
    }
  }, [creating]);

  const savePreview = useCallback(async () => {
    if (!preview || creating) return;
    setCreating(true);
    try {
      await savePickedSticker(preview);
      setPreview(null);
      setQuery('');
      setFilter('personal');
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
      hapticSelection();
    } catch (error) {
      Alert.alert(
        'Enregistrement impossible',
        error instanceof Error ? error.message : 'Impossible de créer ce sticker.',
      );
    } finally {
      setCreating(false);
    }
  }, [creating, preview]);

  const chips: { id: Filter; label: string }[] = useMemo(
    () => [
      { id: 'all', label: 'Tous' },
      { id: 'favorites', label: 'Favoris' },
      { id: 'recents', label: 'Récents' },
      {
        id: 'personal',
        label: personalEntries.length > 0 ? `Mes stickers · ${personalEntries.length}` : 'Mes stickers',
      },
    ],
    [personalEntries.length],
  );

  const emptyLabel = query.trim()
    ? 'Aucun sticker trouvé'
    : filter === 'favorites'
      ? 'Aucun favori — appui long sur un sticker'
      : filter === 'recents'
        ? 'Aucun sticker récent'
        : filter === 'personal'
          ? 'Aucun sticker personnel — crée le tien'
          : 'Aucun sticker';

  const header = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}>
      {chips.map((chip) => {
        const active = filter === chip.id && !query.trim();
        return (
          <Pressable
            key={chip.id}
            onPress={() => chooseFilter(chip.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[
              styles.chip,
              {
                backgroundColor: active ? theme.tabActiveBg : 'transparent',
                borderColor: active ? theme.accent : theme.border,
              },
            ]}>
            <Text
              style={[
                styles.chipText,
                { color: active ? theme.accent : theme.subtle },
                active && styles.chipTextActive,
              ]}>
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <View style={{ height, backgroundColor: theme.panelBg }}>
      <View style={styles.searchRow}>
        <View
          style={[
            styles.searchBar,
            {
              backgroundColor: theme.tabBg,
              borderColor: searchFocused ? theme.accent : theme.border,
            },
          ]}>
          <MaterialCommunityIcons name="magnify" size={18} color={theme.subtle} />
          <TextInput
            ref={searchRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Rechercher un sticker"
            placeholderTextColor={theme.subtle}
            style={[styles.searchInput, { color: theme.text }]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onFocus={handleSearchFocus}
            onBlur={handleSearchBlur}
            accessibilityLabel="Rechercher un sticker"
          />
          {query ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Effacer la recherche">
              <MaterialCommunityIcons name="close-circle" size={18} color={theme.subtle} />
            </Pressable>
          ) : null}
          {searchFocused ? (
            <Pressable
              onPress={() => {
                setQuery('');
                searchRef.current?.blur();
                onSearchFocusChange?.(false);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Quitter la recherche">
              <MaterialCommunityIcons name="chevron-left" size={20} color={theme.subtle} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => void beginCreate()}
          disabled={creating}
          accessibilityRole="button"
          accessibilityLabel="Créer un sticker depuis la galerie"
          style={({ pressed }) => [
            styles.createPill,
            { backgroundColor: theme.tabBg, borderColor: theme.border },
            pressed && { opacity: 0.65 },
          ]}>
          {creating ? (
            <ActivityIndicator size="small" color={theme.accent} />
          ) : (
            <>
              <MaterialCommunityIcons name="plus" size={18} color={theme.accent} />
              <Text style={[styles.createPillText, { color: theme.accent }]}>Créer</Text>
            </>
          )}
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(item) => item.key}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.row}
        contentContainerStyle={[
          styles.grid,
          visible.length === 0 && { minHeight: Math.max(120, height - SEARCH_H - 80) },
        ]}
        style={{ height: Math.max(80, height - SEARCH_H) }}
        ListHeaderComponent={query.trim() ? undefined : header}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MaterialCommunityIcons name="sticker-emoji" size={30} color={theme.subtle} />
            <Text style={[styles.emptyText, { color: theme.subtle }]}>{emptyLabel}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const favorite = favorites.has(item.key);
          return (
            <Pressable
              onPress={() => send(item)}
              onLongPress={() => openOptions(item)}
              delayLongPress={300}
              accessibilityRole="button"
              accessibilityLabel={`Sticker ${item.name}${favorite ? ', favori' : ''}`}
              accessibilityHint="Envoyer ce sticker ; appui long pour les options"
              style={({ pressed }) => [
                styles.cell,
                { width: cellSize, height: cellSize },
                pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] },
              ]}>
              {item.kind === 'catalog' ? (
                <StickerView sticker={item.sticker} size={artSize} />
              ) : (
                <Image
                  source={{ uri: item.personal.uri }}
                  style={{ width: artSize, height: artSize }}
                  contentFit="contain"
                  transition={100}
                  recyclingKey={item.key}
                  accessibilityIgnoresInvertColors
                />
              )}
              {favorite ? (
                <View style={[styles.favoriteBadge, { backgroundColor: theme.accent }]}>
                  <MaterialCommunityIcons name="star" size={11} color={theme.accentText} />
                </View>
              ) : null}
            </Pressable>
          );
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        windowSize={5}
        extraData={favorites}
      />

      <PreviewModal
        preview={preview}
        busy={creating}
        theme={theme}
        onCancel={() => setPreview(null)}
        onSave={() => void savePreview()}
      />
    </View>
  );
}

type PreviewProps = {
  preview: PickedStickerImage | null;
  busy: boolean;
  theme: PanelTheme;
  onCancel: () => void;
  onSave: () => void;
};

function PreviewModal({ preview, busy, theme, onCancel, onSave }: PreviewProps) {
  return (
    <Modal
      visible={preview !== null}
      transparent
      animationType="fade"
      onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: theme.panelBg, borderColor: theme.border }]}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>Aperçu du sticker</Text>
          <Text style={[styles.modalHint, { color: theme.subtle }]}>
            Il sera enregistré dans « Mes stickers » sur cet appareil.
          </Text>
          <Checkerboard>
            {preview ? (
              <Image
                source={{ uri: preview.uri }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
              />
            ) : null}
          </Checkerboard>
          <View style={styles.modalActions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Annuler la création"
              style={[styles.modalButton, { borderColor: theme.border }]}>
              <Text style={{ color: theme.text, fontWeight: '600' }}>Annuler</Text>
            </Pressable>
            <Pressable
              onPress={onSave}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Enregistrer le sticker"
              style={[styles.modalButton, { backgroundColor: theme.accent, borderColor: theme.accent }]}>
              {busy ? (
                <ActivityIndicator size="small" color={theme.accentText} />
              ) : (
                <Text style={{ color: theme.accentText, fontWeight: '700' }}>Enregistrer</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Checkerboard({ children }: { children: React.ReactNode }) {
  const size = 216;
  const squares = 8;
  const cell = size / squares;
  return (
    <View style={[styles.checker, { width: size, height: size }]}>
      {Array.from({ length: squares * squares }, (_, index) => {
        const row = Math.floor(index / squares);
        const column = index % squares;
        return (
          <View
            key={index}
            style={{
              position: 'absolute',
              left: column * cell,
              top: row * cell,
              width: cell,
              height: cell,
              backgroundColor: (row + column) % 2 === 0 ? '#E8E4EE' : '#F8F5FA',
            }}
          />
        );
      })}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    marginTop: 4,
    marginBottom: 4,
  },
  searchBar: {
    flex: 1,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  searchInput: {
    flex: 1,
    height: 38,
    fontSize: 15,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  grid: { paddingHorizontal: GRID_PADDING, paddingBottom: 8 },
  row: { gap: 0 },
  createPill: {
    height: 40,
    paddingHorizontal: 9,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  createPillText: { fontSize: 12, fontWeight: '700' },
  chips: { paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
  chip: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 12.5 },
  chipTextActive: { fontWeight: '700' },
  cell: { alignItems: 'center', justifyContent: 'center' },
  favoriteBadge: {
    position: 'absolute',
    right: 8,
    bottom: 7,
    width: 18,
    height: 18,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 8, paddingTop: 32 },
  emptyText: { fontSize: 13, textAlign: 'center' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 12,
    alignItems: 'center',
  },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalHint: { fontSize: 12.5, textAlign: 'center', lineHeight: 18 },
  checker: { borderRadius: Radii.md, overflow: 'hidden', backgroundColor: '#F8F5FA' },
  modalActions: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 4 },
  modalButton: {
    flex: 1,
    height: 42,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
