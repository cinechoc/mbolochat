import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { conversationTitle, formatListTimestamp } from '@/lib/format';
import { connectSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';

export default function ChatsScreen() {
  const { token, user, signOut } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [menuView, setMenuView] = useState<'menu' | 'profile' | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [typingMap, setTypingMap] = useState<Record<string, { name: string; text: string }>>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      setConversations(await api.listConversations(token));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger les discussions.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  useEffect(() => {
    if (!token || conversations.length === 0) {
      return;
    }
    const socket = connectSocket(token);
    const joinAll = () => {
      for (const conversation of conversations) {
        socket.emit('conversation:join', { conversationId: conversation.id });
      }
    };
    if (socket.connected) {
      joinAll();
    } else {
      socket.on('connect', joinAll);
    }

    const clearTyping = (conversationId: string) => {
      setTypingMap((previous) => {
        if (!(conversationId in previous)) {
          return previous;
        }
        const next = { ...previous };
        delete next[conversationId];
        return next;
      });
      const timer = typingTimersRef.current.get(conversationId);
      if (timer) {
        clearTimeout(timer);
        typingTimersRef.current.delete(conversationId);
      }
    };

    const onMessage = (message: Message) => {
      if (!conversations.some((item) => item.id === message.conversationId)) {
        return;
      }
      clearTyping(message.conversationId);
      setConversations((previous) => {
        const index = previous.findIndex((item) => item.id === message.conversationId);
        if (index < 0) {
          return previous;
        }
        const existing = previous[index];
        const updated: ConversationSummary = {
          ...existing,
          lastMessage: message,
          unreadCount: message.sender.id === user?.id ? existing.unreadCount : existing.unreadCount + 1,
        };
        return [updated, ...previous.filter((_, position) => position !== index)];
      });
    };

    const onTyping = (payload: { conversationId: string; userId: string; text?: string }) => {
      if (payload.userId === user?.id) {
        return;
      }
      const conversation = conversations.find((item) => item.id === payload.conversationId);
      if (!conversation) {
        return;
      }
      const text = (payload.text ?? '').slice(0, 300);
      if (!text) {
        clearTyping(payload.conversationId);
        return;
      }
      const name =
        conversation.members.find((member) => member.id === payload.userId)?.displayName ??
        'Quelqu\u2019un';
      setTypingMap((previous) => ({ ...previous, [payload.conversationId]: { name, text } }));
      const previousTimer = typingTimersRef.current.get(payload.conversationId);
      if (previousTimer) {
        clearTimeout(previousTimer);
      }
      typingTimersRef.current.set(
        payload.conversationId,
        setTimeout(() => {
          typingTimersRef.current.delete(payload.conversationId);
          setTypingMap((previous) => {
            if (!(payload.conversationId in previous)) {
              return previous;
            }
            const next = { ...previous };
            delete next[payload.conversationId];
            return next;
          });
        }, 3000),
      );
    };

    socket.on('message:new', onMessage);
    socket.on('typing', onTyping);

    return () => {
      socket.off('message:new', onMessage);
      socket.off('typing', onTyping);
      socket.off('connect', joinAll);
    };
  }, [token, conversations, user?.id]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !user) {
      return conversations;
    }
    return conversations.filter((item) => {
      const title = conversationTitle(item, user.id).toLowerCase();
      const preview = (item.lastMessage?.content ?? '').toLowerCase();
      return title.includes(needle) || preview.includes(needle);
    });
  }, [conversations, query, user]);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const previewOf = (item: ConversationSummary) => {
    const last = item.lastMessage;
    if (!last) {
      return 'Nouvelle conversation';
    }
    const mine = last.sender.id === user.id;
    if (mine) {
      return `${item.type === 'GROUP' ? '\u2713\u2713 Vous : ' : '\u2713\u2713 '}${last.content}`;
    }
    return item.type === 'GROUP' ? `${last.sender.displayName} : ${last.content}` : last.content;
  };

  const memberSince = new Date(user.createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.flex} edges={['top', 'left', 'right']}>
        <ThemedView style={styles.header}>
          <ThemedText style={styles.brandTitle}>MboloChat</ThemedText>
          <Pressable
            onPress={() => setMenuView('menu')}
            hitSlop={8}
            style={({ pressed }) => pressed && styles.pressed}>
            <Avatar name={user.displayName} uri={user.avatarUrl} size={36} />
          </Pressable>
        </ThemedView>

        <ThemedView style={styles.searchWrapper}>
          <TextField
            style={styles.search}
            placeholder="Rechercher une discussion"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
          />
        </ThemedView>

        {error && !loading ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        {loading ? (
          <ThemedView style={styles.center}>
            <ActivityIndicator size="large" />
          </ThemedView>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            contentContainerStyle={filtered.length === 0 ? styles.emptyList : styles.listContent}
            keyboardShouldPersistTaps="handled"
            onRefresh={refresh}
            refreshing={false}
            ItemSeparatorComponent={() => (
              <View style={[styles.separator, { backgroundColor: theme.backgroundElement }]} />
            )}
            ListEmptyComponent={
              <ThemedView style={styles.center}>
                <ThemedText themeColor="textSecondary" style={styles.emptyText}>
                  {query.trim().length > 0
                    ? 'Aucune discussion ne correspond à ta recherche.'
                    : 'Aucune conversation pour le moment.\nAppuie sur + pour commencer.'}
                </ThemedText>
              </ThemedView>
            }
            renderItem={({ item }) => {
              const title = conversationTitle(item, user.id);
              const rowAvatarUri =
                item.type === 'DIRECT'
                  ? (item.members.find((member) => member.id !== user.id)?.avatarUrl ?? null)
                  : null;
              const unread = item.unreadCount > 0;
              const typingEntry = typingMap[item.id];
              return (
                <Pressable
                  onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })}
                  style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: pressed ? theme.backgroundSelected : theme.background },
                  ]}>
                  <Avatar name={title} uri={rowAvatarUri} size={52} />
                  <ThemedView style={styles.rowBody}>
                    <ThemedText
                      numberOfLines={1}
                      style={[styles.rowTitle, unread && styles.rowUnread]}>
                      {title}
                    </ThemedText>
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      numberOfLines={1}
                      style={[
                        unread && styles.rowUnread,
                        typingEntry && styles.rowPreviewTyping,
                      ]}>
                      {typingEntry
                        ? `${item.type === 'GROUP' ? `${typingEntry.name} · ` : ''}en train d'écrire : ${typingEntry.text}`
                        : previewOf(item)}
                    </ThemedText>
                  </ThemedView>
                  <ThemedView style={styles.rowMeta}>
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      style={unread ? styles.rowTimeUnread : undefined}>
                      {formatListTimestamp(item.lastMessage?.createdAt ?? item.createdAt)}
                    </ThemedText>
                    {unread ? (
                      <ThemedView style={styles.badge}>
                        <ThemedText style={styles.badgeText}>
                          {item.unreadCount > 99 ? '99+' : item.unreadCount}
                        </ThemedText>
                      </ThemedView>
                    ) : null}
                  </ThemedView>
                </Pressable>
              );
            }}
          />
        )}

        <Modal
          visible={menuView !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setMenuView(null)}>
          <Pressable
            style={[styles.backdrop, menuView === 'profile' && styles.backdropDim]}
            onPress={() => setMenuView(null)}>
            {menuView === 'menu' ? (
              <Pressable
                onPress={() => undefined}
                style={[
                  styles.menuCard,
                  {
                    top: insets.top + 52,
                    backgroundColor: theme.background,
                    borderColor: theme.backgroundElement,
                  },
                ]}>
                <ThemedView style={styles.menuHeader}>
                  <Avatar name={user.displayName} uri={user.avatarUrl} size={48} />
                  <ThemedView style={styles.menuHeaderBody}>
                    <ThemedText numberOfLines={1} style={styles.menuName}>
                      {user.displayName}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      @{user.username}
                    </ThemedText>
                  </ThemedView>
                </ThemedView>
                <View style={[styles.menuDivider, { backgroundColor: theme.backgroundElement }]} />
                <Pressable
                  onPress={() => { setMenuView(null); router.push('/profile'); }}
                  style={({ pressed }) => [
                    styles.menuItem,
                    pressed && { backgroundColor: theme.backgroundSelected },
                  ]}>
                  <ThemedText>Mon profil</ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMenuView(null);
                    router.push('/new-chat');
                  }}
                  style={({ pressed }) => [
                    styles.menuItem,
                    pressed && { backgroundColor: theme.backgroundSelected },
                  ]}>
                  <ThemedText>Nouvelle discussion</ThemedText>
                </Pressable>
                <View style={[styles.menuDivider, { backgroundColor: theme.backgroundElement }]} />
                <Pressable
                  onPress={async () => {
                    setMenuView(null);
                    await signOut();
                  }}
                  style={({ pressed }) => [
                    styles.menuItem,
                    pressed && { backgroundColor: theme.backgroundSelected },
                  ]}>
                  <ThemedText style={styles.danger}>Se déconnecter</ThemedText>
                </Pressable>
              </Pressable>
            ) : (
              <Pressable onPress={() => undefined} style={styles.profileWrapper}>
                <ThemedView
                  style={[styles.profileCard, { borderColor: theme.backgroundElement }]}>
                  <Avatar name={user.displayName} uri={user.avatarUrl} size={72} />
                  <ThemedText type="subtitle">{user.displayName}</ThemedText>
                  <ThemedText themeColor="textSecondary">@{user.username}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    Membre depuis le {memberSince}
                  </ThemedText>
                  <ThemedView style={styles.profileButton}>
                    <Button title="Fermer" variant="secondary" onPress={() => setMenuView(null)} />
                  </ThemedView>
                </ThemedView>
              </Pressable>
            )}
          </Pressable>
        </Modal>

        <Pressable
          onPress={() => router.push('/new-chat')}
          style={({ pressed }) => [styles.fab, pressed && styles.pressed]}>
          <ThemedText style={styles.fabIcon}>+</ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  brandTitle: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '800',
    color: accentColor,
  },
  searchWrapper: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  search: {
    borderRadius: 22,
    paddingVertical: Spacing.two,
  },
  pressed: {
    opacity: 0.6,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyText: {
    textAlign: 'center',
  },
  listContent: {
    paddingBottom: 96,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    gap: Spacing.three,
  },
  rowBody: {
    flex: 1,
    gap: Spacing.half,
  },
  rowMeta: {
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: accentColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  rowTitle: {
    fontWeight: '600',
    fontSize: 16,
    lineHeight: 22,
  },
  rowUnread: {
    fontWeight: '700',
  },
  rowPreviewTyping: {
    fontStyle: 'italic',
  },
  rowTimeUnread: {
    color: accentColor,
    fontWeight: '700',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 84,
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.one,
  },
  fab: {
    position: 'absolute',
    right: Spacing.four,
    bottom: Spacing.five,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: accentColor,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  fabIcon: {
    color: '#ffffff',
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '400',
    marginTop: -2,
  },
  backdrop: {
    flex: 1,
  },
  backdropDim: {
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  menuCard: {
    position: 'absolute',
    right: Spacing.three,
    minWidth: 252,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.one,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  menuHeaderBody: {
    flex: 1,
    gap: Spacing.half,
  },
  menuName: {
    fontWeight: '700',
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  menuItem: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
  },
  danger: {
    color: '#e5484d',
    fontWeight: '600',
  },
  profileWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  profileCard: {
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.four,
    shadowColor: '#000000',
    shadowOpacity: 0.22,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  profileButton: {
    alignSelf: 'stretch',
    marginTop: Spacing.two,
  },
});
