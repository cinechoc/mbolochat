import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { FileText, Link2, Search } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TextField } from '@/components/ui';
import { Gutter, Radii, Spacing } from '@/constants/theme';
import { ImageViewer } from '@/features/media/MediaViewers';
import { mediaUrl } from '@/features/media/mediaUrl';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDateLabel } from '@/lib/format';
import type {
  ConversationLinkItem,
  ConversationMediaItem,
  ConversationSearchHit,
} from '@/lib/types';

/** Recherche dans l'historique + médias, liens et documents de la conversation. */
export default function ConversationSearchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useAuth();
  const theme = useTheme();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ConversationSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [media, setMedia] = useState<{
    attachments: ConversationMediaItem[];
    links: ConversationLinkItem[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ urls: string[]; index: number } | null>(null);

  const searchActive = query.trim().length > 0;

  useEffect(() => {
    if (!token || !id) return;
    let active = true;
    api
      .listConversationMedia(token, id)
      .then((result) => {
        if (active) setMedia(result);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof ApiError ? err.message : 'Impossible de charger les médias.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [token, id]);

  useEffect(() => {
    if (!token || !id) return;
    const term = query.trim();
    if (term.length === 0) return;
    let active = true;
    const timeout = setTimeout(() => {
      setSearching(true);
      api
        .searchConversation(token, id, term)
        .then((results) => {
          if (active) {
            setHits(results);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (active) {
            setError(err instanceof ApiError ? err.message : 'Recherche impossible.');
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [token, id, query]);

  const images = useMemo(
    () =>
      (media?.attachments ?? []).filter(
        (item) => item.type === 'IMAGE' || item.type === 'GIF',
      ),
    [media],
  );
  const files = useMemo(
    () =>
      (media?.attachments ?? []).filter(
        (item) => item.type !== 'IMAGE' && item.type !== 'GIF',
      ),
    [media],
  );
  const imageUrls = useMemo(() => images.map((item) => mediaUrl(item.url)), [images]);

  const openDocument = (item: ConversationMediaItem) => {
    router.push({
      pathname: '/document-viewer',
      params: {
        url: mediaUrl(item.url),
        name: item.name ?? 'fichier',
        mime: item.mime,
        size: '0',
      },
    });
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Recherche' }} />
      <View style={styles.searchRow}>
        <Search size={18} color={theme.textSecondary} />
        <TextField
          style={styles.search}
          placeholder="Rechercher dans la conversation"
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCorrect={false}
          accessibilityLabel="Rechercher dans la conversation"
        />
        {searching && searchActive ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : null}
      </View>

      {error ? (
        <ThemedText type="caption" style={{ color: theme.danger }} accessibilityRole="alert">
          {error}
        </ThemedText>
      ) : null}

      {searchActive ? (
        <FlatList
          data={hits}
          keyExtractor={(hit) => hit.messageId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={hits.length === 0 ? styles.emptyList : styles.list}
          ListEmptyComponent={
            searching ? undefined : (
              <ThemedText type="caption" themeColor="textSecondary" style={styles.empty}>
                Aucun message ne contient « {query.trim()} ».
              </ThemedText>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() =>
                router.navigate({ pathname: '/chat/[id]', params: { id: id ?? '' } })
              }
              accessibilityRole="button"
              accessibilityLabel={`Message de ${item.senderName}`}
              style={({ pressed }) => [
                styles.hit,
                pressed && { backgroundColor: theme.backgroundSelected },
              ]}>
              <Avatar name={item.senderName} size={36} />
              <View style={styles.hitBody}>
                <ThemedText numberOfLines={1} style={styles.hitSender}>
                  {item.senderName}
                </ThemedText>
                <ThemedText type="caption" numberOfLines={2} themeColor="textSecondary">
                  {item.content}
                </ThemedText>
              </View>
              <ThemedText type="micro" themeColor="textSecondary">
                {formatDateLabel(item.createdAt)}
              </ThemedText>
            </Pressable>
          )}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.sections} keyboardShouldPersistTaps="handled">
          <View style={styles.section}>
            <ThemedText type="sectionTitle">Médias</ThemedText>
            {images.length === 0 ? (
              <ThemedText type="caption" themeColor="textSecondary">
                Aucune photo ni vidéo partagée.
              </ThemedText>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.thumbs}>
                  {images.map((item, index) => (
                    <Pressable
                      key={item.messageId}
                      onPress={() => setViewer({ urls: imageUrls, index })}
                      accessibilityRole="button"
                      accessibilityLabel={`Photo de ${item.senderName}`}>
                      <Image
                        source={{ uri: mediaUrl(item.url) }}
                        style={[styles.thumb, { backgroundColor: theme.backgroundElement }]}
                        contentFit="cover"
                      />
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>

          <View style={styles.section}>
            <ThemedText type="sectionTitle">Liens</ThemedText>
            {!media || media.links.length === 0 ? (
              <ThemedText type="caption" themeColor="textSecondary">
                Aucun lien partagé.
              </ThemedText>
            ) : (
              media.links.map((link) => (
                <Pressable
                  key={`${link.messageId}-${link.url}`}
                  onPress={() => void Linking.openURL(link.url)}
                  accessibilityRole="link"
                  accessibilityLabel={`Ouvrir ${link.url}`}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
                  <Link2 size={18} color={theme.accent} />
                  <View style={styles.rowBody}>
                    <ThemedText numberOfLines={1} style={{ color: theme.accent }}>
                      {link.url.replace(/^https?:\/\//, '')}
                    </ThemedText>
                    <ThemedText type="micro" themeColor="textSecondary">
                      {link.senderName}
                    </ThemedText>
                  </View>
                </Pressable>
              ))
            )}
          </View>

          <View style={styles.section}>
            <ThemedText type="sectionTitle">Documents</ThemedText>
            {files.length === 0 ? (
              <ThemedText type="caption" themeColor="textSecondary">
                Aucun document partagé.
              </ThemedText>
            ) : (
              files.map((item) => (
                <Pressable
                  key={item.messageId}
                  onPress={() => openDocument(item)}
                  accessibilityRole="button"
                  accessibilityLabel={item.name ?? 'Document'}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
                  <FileText size={18} color={theme.textSecondary} />
                  <View style={styles.rowBody}>
                    <ThemedText numberOfLines={1}>{item.name ?? 'Fichier'}</ThemedText>
                    <ThemedText type="micro" themeColor="textSecondary">
                      {item.senderName} · {formatDateLabel(item.createdAt)}
                    </ThemedText>
                  </View>
                </Pressable>
              ))
            )}
          </View>
        </ScrollView>
      )}

      {viewer ? (
        <ImageViewer
          urls={viewer.urls}
          initialIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Gutter,
    paddingVertical: Spacing.two,
  },
  search: { flex: 1, borderRadius: Radii.md },
  list: { paddingBottom: Spacing.four },
  emptyList: { flexGrow: 1 },
  empty: { textAlign: 'center', padding: Spacing.five },
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    paddingHorizontal: Gutter,
    paddingVertical: Spacing.two,
    minHeight: 64,
  },
  hitBody: { flex: 1, gap: 1 },
  hitSender: { fontWeight: '600' },
  sections: { padding: Gutter, gap: Spacing.four },
  section: { gap: Spacing.two },
  thumbs: { flexDirection: 'row', gap: Spacing.two },
  thumb: { width: 96, height: 96, borderRadius: Radii.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    minHeight: 48,
  },
  rowBody: { flex: 1, gap: 1 },
});
