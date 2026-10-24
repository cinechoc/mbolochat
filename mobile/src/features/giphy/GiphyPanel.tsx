import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
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
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  GIPHY_API_KEY,
  fetchGiphyFeed,
  gifPayloadOf,
  pingGiphy,
  type GifPanelItem,
  type GiphyFeed,
} from '@/lib/giphy';
import type { GifSendPayload } from '@/lib/types';

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

export const GIPHY_PAGE_SIZE = 24;
const COLUMN_TARGET = 110;
const TILE_GAP = 4;

interface GiphyPanelProps {
  /** L'item choisi part dans la conversation (panneau refermé au retour). */
  onSend: (gif: GifSendPayload) => void;
  /** Clé bêta GIPHY (client direct, exigence des ToS : pas de proxy). */
  apiKey?: string;
  /** Identifiant utilisateur stable, transmis en `customer_id` GIPHY. */
  customerId?: string;
  /** Rendu dans le panneau d'expression unifié : pas de cadre ni d'animation. */
  embedded?: boolean;
  /** `gifs` fige le flux sur les GIF ; `both` conserve les deux segments. */
  feedMode?: 'both' | 'gifs';
}

/**
 * Panneau GIPHY : stickers animés et GIFs, recherche et tendances.
 *
 * Conformité GIPHY : grille dédiée (aucun contenu d'un autre fournisseur
 * mélangé), résultats dans l'ordre renvoyé, attribution « Powered By GIPHY »
 * affichée, aperçu haute résolution avant envoi, pingbacks analytics.
 */
export const GiphyPanel = memo(function GiphyPanel({
  onSend,
  apiKey = GIPHY_API_KEY,
  customerId,
  embedded = false,
  feedMode = 'both',
}: GiphyPanelProps) {
  const chat = useChatColors();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const [feed, setFeed] = useState<GiphyFeed>(feedMode === 'gifs' ? 'gifs' : 'stickers');

  useEffect(() => {
    if (feedMode === 'gifs') setFeed('gifs');
  }, [feedMode]);
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<GifPanelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GifPanelItem | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  /** Garde-fou : seules les réponses du dernier instant s'installent. */
  const sequence = useRef(0);
  const offsetRef = useRef(0);

  const load = useCallback(
    async (offset: number, query: string, currentFeed: GiphyFeed, appending: boolean) => {
      const ticket = ++sequence.current;
      offsetRef.current = offset;
      if (appending) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await fetchGiphyFeed({
          feed: currentFeed,
          mode: query.trim() ? 'search' : 'trending',
          q: query.trim() || undefined,
          limit: GIPHY_PAGE_SIZE,
          offset,
          apiKey,
          customerId,
        });
        if (ticket !== sequence.current) return;
        setItems((previous) =>
          offset === 0 ? page : [...previous, ...page],
        );
        setError(null);
      } catch (err) {
        if (ticket !== sequence.current) return;
        setError(err instanceof Error ? err.message : 'GIPHY est indisponible.');
      } finally {
        if (ticket === sequence.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [apiKey, customerId],
  );

  // Recherche débouncée : une requête après la frappe, pas à chaque lettre
  // (300 ms — la clé bêta plafonne à 100 appels/heure).
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(0, term, feed, false);
    }, 300);
    return () => clearTimeout(timer);
  }, [term, feed, load]);

  const tilesPerRow = Math.max(2, Math.floor(windowWidth / COLUMN_TARGET));
  // Largeur fixe exigée par FlatList : les tuiles partagent l'espace de la
  // grille (padding horizontal Spacing.two de chaque côté), écart 4 px.
  const available = windowWidth - 2 * (Spacing.two as number);
  const tileWidth = Math.floor(available / tilesPerRow) - TILE_GAP;
  const columns = tilesPerRow;

  const send = useCallback(
    (item: GifPanelItem) => {
      void hapticSelection();
      setPreview(null);
      void pingGiphy(item.onsent, customerId);
      onSend(gifPayloadOf(item));
    },
    [customerId, onSend],
  );

  const renderItem = useCallback(
    ({ item }: { item: GifPanelItem }) => {
      const height = Math.min(Math.round(tileWidth * 1.4), 150);
      return (
        <Pressable
          onPress={() => {
            void hapticSelection();
            void pingGiphy(item.onclick, customerId);
            setPreviewLoading(true);
            setPreview(item);
          }}
          style={[
            styles.tile,
            { width: tileWidth, height, margin: TILE_GAP / 2 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Aperçu du GIF ${item.title ?? item.id}`}>
          <Image
            source={{ uri: item.gridUrl }}
            placeholder={item.gridStillUrl ? { uri: item.gridStillUrl } : undefined}
            style={styles.tileImage}
            contentFit="cover"
            transition={140}
            recyclingKey={item.id}
            cachePolicy="memory"
          />
        </Pressable>
      );
    },
    [tileWidth, customerId],
  );

  if (!apiKey) {
    return (
      <PanelFrame windowHeight={windowHeight} insets={insets} embedded={embedded}>
        <View style={styles.centerState}>
          <Ionicons name="sparkles-outline" size={34} color={chat.inputPlaceholder} />
          <ThemedText type="smallBold" style={{ color: chat.primaryText, textAlign: 'center' }}>
            GIF désactivés
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.stateHint}>
            Ajoute une clé GIPHY bêta dans mobile/.env (EXPO_PUBLIC_GIPHY_API_KEY) pour
            activer stickers animés et GIFs.
          </ThemedText>
        </View>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame windowHeight={windowHeight} insets={insets} embedded={embedded}>
      <View style={styles.header}>
        {feedMode === 'both' ? (
          <>
            <SegmentTab
              label="Stickers"
              active={feed === 'stickers'}
              color={chat.mineBubble}
              inactiveColor={chat.theirBubble}
              textColor={chat.primaryText}
              onPress={() => setFeed('stickers')}
            />
            <SegmentTab
              label="GIF"
              active={feed === 'gifs'}
              color={chat.mineBubble}
              inactiveColor={chat.theirBubble}
              textColor={chat.primaryText}
              onPress={() => setFeed('gifs')}
            />
          </>
        ) : null}
        <TextInput
          style={[styles.search, { backgroundColor: chat.input, color: chat.primaryText }]}
          placeholder={feed === 'stickers' ? 'Chercher un sticker…' : 'Chercher un GIF…'}
          placeholderTextColor={chat.inputPlaceholder}
          value={term}
          onChangeText={setTerm}
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel={feed === 'stickers' ? 'Rechercher un sticker GIPHY' : 'Rechercher un GIF'}
        />
      </View>

      {loading ? (
        <View style={[styles.gridArea, styles.centerState]}>
          <ActivityIndicator color={chat.mineBubble} />
          <ThemedText type="small" themeColor="textSecondary">
            Chargement…
          </ThemedText>
        </View>
      ) : error ? (
        <View style={[styles.gridArea, styles.centerState]}>
          <Ionicons name="cloud-offline-outline" size={30} color={chat.inputPlaceholder} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.stateHint}>
            {error}
          </ThemedText>
          <Pressable
            onPress={() => void load(0, term, feed, false)}
            style={[styles.retry, { backgroundColor: chat.mineBubble }]}>
            <ThemedText type="smallBold" style={{ color: chat.mineText ?? '#fff' }}>
              Réessayer
            </ThemedText>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={[styles.gridArea, styles.centerState]}>
          <Ionicons name="search-outline" size={30} color={chat.inputPlaceholder} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.stateHint}>
            Aucun résultat{term.trim() ? ` pour « ${term.trim()} »` : ' — réessaie dans un instant'}
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={items}
          key={`${feed}-${columns}`}
          numColumns={columns}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.grid}
          style={styles.gridArea}
          initialNumToRender={12}
          windowSize={5}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.moreSpinner} color={chat.mineBubble} />
            ) : undefined
          }
          onEndReachedThreshold={0.9}
          onEndReached={() => {
            if (loadingMore) return;
            void load(offsetRef.current + GIPHY_PAGE_SIZE, term, feed, true);
          }}
        />
      )}

      {/* Attribution officielle : exigée là où l'API est utilisée. */}
      <Pressable
        style={styles.attribution}
        onPress={() => void Linking.openURL('https://giphy.com')}
        accessibilityRole="link"
        accessibilityLabel="Propulsé par GIPHY">
        {isDark ? (
          <Image
            source={require('@/assets/giphy/powered-by-dark.png')}
            style={styles.attributionMark}
            contentFit="contain"
          />
        ) : (
          <Image
            source={require('@/assets/giphy/powered-by-light.png')}
            style={styles.attributionMark}
            contentFit="contain"
          />
        )}
      </Pressable>

      {/* Aperçu avant envoi : rendu haute résolution, attribution du compte. */}
      <Modal
        visible={preview !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setPreview(null)}>
        <View style={styles.previewRoot}>
          <Pressable style={styles.previewBackdrop} onPress={() => setPreview(null)} />
          <View style={styles.previewCard}>
            {preview ? (
              <>
                <View style={styles.previewImageWrap}>
                  <Image
                    source={{ uri: preview.sendUrl }}
                    placeholder={preview.stillUrl ? { uri: preview.stillUrl } : undefined}
                    style={styles.previewImage}
                    contentFit="contain"
                    transition={160}
                    onLoad={() => setPreviewLoading(false)}
                    cachePolicy="memory"
                  />
                  {previewLoading ? (
                    <ActivityIndicator style={styles.previewSpinner} color={chat.mineBubble} />
                  ) : null}
                </View>
                <ThemedText type="small" themeColor="textSecondary" style={styles.attributionLine}>
                  {preview.username ? `@${preview.username} · ` : ''}
                  Propulsé par GIPHY
                </ThemedText>
                <View style={styles.previewActions}>
                  <Pressable onPress={() => setPreview(null)} style={styles.previewCancel} hitSlop={6}>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      Annuler
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={() => send(preview)}
                    style={[styles.previewSend, { backgroundColor: chat.mineBubble }]}>
                    <Ionicons name="send" size={15} color={chat.mineText ?? '#fff'} />
                    <ThemedText type="smallBold" style={{ color: chat.mineText ?? '#fff' }}>
                      Envoyer
                    </ThemedText>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </PanelFrame>
  );
});

const SegmentTab = memo(function SegmentTab({
  label,
  active,
  onPress,
  color,
  inactiveColor,
  textColor,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  color: string;
  inactiveColor: string;
  textColor: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[
        styles.segment,
        active
          ? { backgroundColor: color }
          : { backgroundColor: inactiveColor },
      ]}>
      <Text style={[styles.segmentText, { color: textColor }, !active && styles.segmentIdle]}>
        {label}
      </Text>
    </Pressable>
  );
});

/** Coeur du panneau : hauteur identique au panneau d'émojis, fond composer. */
const PanelFrame = memo(function PanelFrame({
  children,
  windowHeight,
  insets,
  embedded,
}: {
  children: React.ReactNode;
  windowHeight: number;
  insets: { bottom: number };
  embedded: boolean;
}) {
  const chat = useChatColors();
  const height = Math.max(260, Math.min(348, Math.round(windowHeight * 0.38)));
  if (embedded) {
    return (
      <View style={[styles.panel, styles.embedded, { backgroundColor: chat.composer }]}>
        {children}
      </View>
    );
  }
  return (
    <Animated.View
      entering={FadeInDown.duration(160)}
      exiting={FadeOutDown.duration(120)}
      style={[
        styles.panel,
        {
          backgroundColor: chat.composer,
          borderTopColor: chat.border,
          height,
          paddingBottom: Math.max(insets.bottom, Spacing.three),
        },
      ]}>
      {children}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  embedded: {
    flex: 1,
    borderTopWidth: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  segment: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  segmentText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  segmentIdle: {
    opacity: 0.62,
  },
  search: {
    flex: 1,
    height: 33,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 0,
    fontSize: 13.5,
    textAlignVertical: 'center',
  },
  gridArea: {
    flex: 1,
  },
  grid: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  tile: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  centerState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
  stateHint: {
    textAlign: 'center',
    lineHeight: 18,
  },
  retry: {
    marginTop: Spacing.one,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  moreSpinner: {
    marginVertical: Spacing.two,
  },
  attribution: {
    flexShrink: 0,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(127,127,127,0.25)',
  },
  attributionMark: {
    width: 108,
    height: 18,
  },
  previewRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  previewCard: {
    alignSelf: 'stretch',
    marginHorizontal: Spacing.three,
  },
  previewImageWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 180,
  },
  previewImage: {
    width: '94%',
    aspectRatio: 1.2,
    borderRadius: 14,
  },
  previewSpinner: {
    position: 'absolute',
  },
  attributionLine: {
    textAlign: 'center',
    marginTop: Spacing.one,
  },
  previewActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  previewCancel: {
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  previewSend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
});
