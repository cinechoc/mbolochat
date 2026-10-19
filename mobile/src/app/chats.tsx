import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionSheet, type SheetAction, type SheetIcon } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { ConversationRow, type TypingEntry } from '@/components/conversation-row';
import { FilterTabs } from '@/components/filter-tabs';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  conversationSectionLabel,
  conversationTitle,
  type ConversationFilter,
} from '@/lib/format';
import { connectSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';

type ListRow =
  | { key: string; type: 'section'; label: string }
  | { key: string; type: 'conversation'; conversation: ConversationSummary };

/** Épinglées d'abord, puis discussions les plus récentes en tête. */
function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    const aDate = new Date(a.lastMessage?.createdAt ?? a.createdAt).getTime();
    const bDate = new Date(b.lastMessage?.createdAt ?? b.createdAt).getTime();
    return bDate - aDate;
  });
}

export default function ChatsScreen() {
  const { token, user, signOut } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [menuView, setMenuView] = useState<'menu' | 'profile' | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [typingMap, setTypingMap] = useState<Record<string, TypingEntry>>({});
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionTarget, setActionTarget] = useState<ConversationSummary | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<ConversationSummary | null>(null);
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const conversationsRef = useRef<ConversationSummary[]>([]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const list = await api.listConversations(token);
      setConversations(sortConversations(list));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger les discussions.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // Rejoint les salons de toutes les discussions affichées (temps réel).
  useEffect(() => {
    if (!token || conversations.length === 0) {
      return;
    }
    const socket = connectSocket(token);
    for (const conversation of conversations) {
      socket.emit('conversation:join', { conversationId: conversation.id });
    }
  }, [token, conversations]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const socket = connectSocket(token);

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
      if (!conversationsRef.current.some((item) => item.id === message.conversationId)) {
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
          unreadCount:
            message.sender.id === user?.id ? existing.unreadCount : existing.unreadCount + 1,
        };
        const next = previous.filter((_, position) => position !== index);
        return sortConversations([updated, ...next]);
      });
    };

    const onTyping = (payload: { conversationId: string; userId: string; text?: string }) => {
      if (payload.userId === user?.id) {
        return;
      }
      const conversation = conversationsRef.current.find(
        (item) => item.id === payload.conversationId,
      );
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

    const onRead = (payload: { conversationId: string; userId: string; at: string }) => {
      setConversations((previous) =>
        previous.map((conversation) => {
          if (conversation.id !== payload.conversationId) {
            return conversation;
          }
          return {
            ...conversation,
            members: conversation.members.map((member) =>
              member.id === payload.userId ? { ...member, lastReadAt: payload.at } : member,
            ),
          };
        }),
      );
    };

    socket.on('message:new', onMessage);
    socket.on('typing', onTyping);
    socket.on('read', onRead);

    return () => {
      socket.off('message:new', onMessage);
      socket.off('typing', onTyping);
      socket.off('read', onRead);
    };
  }, [token, user?.id]);

  const filteredRows = useMemo<ListRow[]>(() => {
    const needle = query.trim().toLowerCase();
    const matching = conversations.filter((item) => {
      if (filter === 'unread' && item.unreadCount === 0) {
        return false;
      }
      if (filter === 'groups' && item.type !== 'GROUP') {
        return false;
      }
      if (!needle) {
        return true;
      }
      const title = conversationTitle(item, user?.id ?? '').toLowerCase();
      const preview = (item.lastMessage?.content ?? '').toLowerCase();
      return title.includes(needle) || preview.includes(needle);
    });

    const rows: ListRow[] = [];
    const pinned = matching.filter((item) => item.pinned);
    if (pinned.length > 0) {
      rows.push({ key: 'section-pinned', type: 'section', label: 'Épinglées' });
      for (const conversation of pinned) {
        rows.push({ key: conversation.id, type: 'conversation', conversation });
      }
    }

    let currentLabel = '';
    for (const conversation of matching.filter((item) => !item.pinned)) {
      const label = conversationSectionLabel(
        conversation.lastMessage?.createdAt ?? conversation.createdAt,
      );
      if (label !== currentLabel) {
        currentLabel = label;
        rows.push({ key: `section-${label}`, type: 'section', label });
      }
      rows.push({ key: conversation.id, type: 'conversation', conversation });
    }
    return rows;
  }, [conversations, filter, query, user?.id]);

  const filterOptions = useMemo(
    () => [
      { key: 'all' as const, label: 'Toutes', count: conversations.length },
      {
        key: 'unread' as const,
        label: 'Non lus',
        count: conversations.filter((item) => item.unreadCount > 0).length,
      },
      {
        key: 'groups' as const,
        label: 'Groupes',
        count: conversations.filter((item) => item.type === 'GROUP').length,
      },
    ],
    [conversations],
  );

  const totalUnread = useMemo(
    () =>
      conversations
        .filter((item) => !item.muted)
        .reduce((total, item) => total + item.unreadCount, 0),
    [conversations],
  );

  const applyPreferences = useCallback(
    async (
      conversation: ConversationSummary,
      body: { pinned?: boolean; muted?: boolean },
    ) => {
      if (!token) {
        return;
      }
      try {
        const updated = await api.setConversationPreferences(token, conversation.id, body);
        setConversations((previous) =>
          sortConversations(previous.map((item) => (item.id === updated.id ? updated : item))),
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Action impossible.');
      }
    },
    [token],
  );

  const markConversationRead = useCallback(
    async (conversation: ConversationSummary) => {
      if (!token) {
        return;
      }
      try {
        await api.markRead(token, conversation.id);
        setConversations((previous) =>
          previous.map((item) =>
            item.id === conversation.id ? { ...item, unreadCount: 0 } : item,
          ),
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Impossible de marquer comme lu.');
      }
    },
    [token],
  );

  const markAllRead = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      await api.markAllRead(token);
      setConversations((previous) => previous.map((item) => ({ ...item, unreadCount: 0 })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de tout marquer comme lu.');
    }
  }, [token]);

  const leaveConversation = useCallback(
    async (conversation: ConversationSummary) => {
      if (!token || !user) {
        return;
      }
      try {
        await api.removeConversationMember(token, conversation.id, user.id);
        setConversations((previous) => previous.filter((item) => item.id !== conversation.id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Impossible de quitter la discussion.');
      }
    },
    [token, user],
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const memberSince = new Date(user.createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const sheetActions: SheetAction[] = actionTarget
    ? [
        ...(actionTarget.unreadCount > 0
          ? ([
              {
                key: 'read',
                label: 'Marquer comme lu',
                icon: 'mark-email-read',
                onPress: () => {
                  setActionTarget(null);
                  void markConversationRead(actionTarget);
                },
              },
            ] satisfies SheetAction[])
          : []),
        {
          key: 'pin',
          label: actionTarget.pinned ? 'Désépingler' : 'Épingler la discussion',
          icon: (actionTarget.pinned ? 'fiber-pin' : 'push-pin') as SheetIcon,
          onPress: () => {
            setActionTarget(null);
            void applyPreferences(actionTarget, { pinned: !actionTarget.pinned });
          },
        },
        {
          key: 'mute',
          label: actionTarget.muted ? 'Réactiver les notifications' : 'Couper les notifications',
          icon: (actionTarget.muted ? 'notifications' : 'notifications-off') as SheetIcon,
          onPress: () => {
            setActionTarget(null);
            void applyPreferences(actionTarget, { muted: !actionTarget.muted });
          },
        },
        ...(actionTarget.type === 'GROUP'
          ? ([
              {
                key: 'info',
                label: 'Infos de la discussion',
                icon: 'info-outline',
                onPress: () => {
                  const id = actionTarget.id;
                  setActionTarget(null);
                  router.push({ pathname: '/conversation-settings/[id]', params: { id } });
                },
              },
            ] satisfies SheetAction[])
          : []),
        {
          key: 'leave',
          label:
            actionTarget.type === 'GROUP'
              ? 'Quitter la discussion'
              : 'Supprimer la conversation',
          icon: 'logout',
          destructive: true,
          onPress: () => {
            setActionTarget(null);
            setLeaveTarget(actionTarget);
          },
        },
      ]
    : [];

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.flex} edges={['top', 'left', 'right']}>
        <ThemedView style={styles.header}>
          <ThemedView style={styles.headerTitleRow}>
            <ThemedText style={styles.brandTitle}>MboloChat</ThemedText>
            {totalUnread > 0 ? (
              <ThemedView style={styles.headerBadge}>
                <ThemedText style={styles.headerBadgeText}>
                  {totalUnread > 99 ? '99+' : totalUnread}
                </ThemedText>
              </ThemedView>
            ) : null}
          </ThemedView>
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

        <FilterTabs options={filterOptions} value={filter} onChange={setFilter} />

        {error ? (
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
            data={filteredRows}
            keyExtractor={(item) => item.key}
            contentContainerStyle={filteredRows.length === 0 ? styles.emptyList : styles.listContent}
            keyboardShouldPersistTaps="handled"
            onRefresh={refresh}
            refreshing={refreshing}
            ItemSeparatorComponent={({ leadingItem }) => {
              if (leadingItem.type === 'section') {
                return null;
              }
              return (
                <View
                  style={[styles.separator, { backgroundColor: theme.backgroundElement }]}
                />
              );
            }}
            ListEmptyComponent={
              <ThemedView style={styles.center}>
                <ThemedText themeColor="textSecondary" style={styles.emptyText}>
                  {query.trim().length > 0
                    ? 'Aucune discussion ne correspond à ta recherche.'
                    : filter === 'unread'
                      ? 'Tout est lu !'
                      : filter === 'groups'
                        ? 'Aucun groupe pour le moment.'
                        : 'Aucune conversation pour le moment.\nAppuie sur + pour commencer.'}
                </ThemedText>
              </ThemedView>
            }
            renderItem={({ item }) => {
              if (item.type === 'section') {
                return (
                  <ThemedView style={styles.sectionRow}>
                    <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
                      {item.label.toUpperCase()}
                    </ThemedText>
                  </ThemedView>
                );
              }
              const conversation = item.conversation;
              return (
                <ConversationRow
                  conversation={conversation}
                  currentUserId={user.id}
                  typing={typingMap[conversation.id] ?? null}
                  onPress={() =>
                    router.push({ pathname: '/chat/[id]', params: { id: conversation.id } })
                  }
                  onLongPress={() => setActionTarget(conversation)}
                />
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
                {totalUnread > 0 ? (
                  <Pressable
                    onPress={() => {
                      setMenuView(null);
                      void markAllRead();
                    }}
                    style={({ pressed }) => [
                      styles.menuItem,
                      pressed && { backgroundColor: theme.backgroundSelected },
                    ]}>
                    <ThemedText>Tout marquer comme lu</ThemedText>
                  </Pressable>
                ) : null}
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

        <ActionSheet
          visible={actionTarget !== null}
          title={actionTarget ? conversationTitle(actionTarget, user.id) : undefined}
          subtitle={
            actionTarget
              ? actionTarget.type === 'GROUP'
                ? `${actionTarget.members.length} membres`
                : undefined
              : undefined
          }
          actions={sheetActions}
          onClose={() => setActionTarget(null)}
        />

        <ActionSheet
          visible={leaveTarget !== null}
          title={leaveTarget ? conversationTitle(leaveTarget, user.id) : undefined}
          subtitle={
            leaveTarget?.type === 'GROUP'
              ? 'Tu ne pourras plus recevoir les messages de ce groupe.'
              : 'La conversation disparaîtra de ta liste.'
          }
          actions={
            leaveTarget
              ? [
                  {
                    key: 'cancel',
                    label: 'Annuler',
                    onPress: () => setLeaveTarget(null),
                  },
                  {
                    key: 'confirm',
                    label:
                      leaveTarget.type === 'GROUP'
                        ? 'Quitter la discussion'
                        : 'Supprimer la conversation',
                    destructive: true,
                    onPress: () => {
                      const target = leaveTarget;
                      setLeaveTarget(null);
                      void leaveConversation(target);
                    },
                  },
                ]
              : []
          }
          onClose={() => setLeaveTarget(null)}
        />

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
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: accentColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
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
  sectionRow: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.one,
  },
  sectionLabel: {
    letterSpacing: 0.8,
    fontSize: 12,
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
