import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LiquidGlass } from '@/components/liquid-glass';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { connectSocket, ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';
import { bootstrapE2ee } from '@/features/e2ee/bootstrap';
import {
  knownMessageKeys,
  listLocalMessages,
  loadDraft,
  loadE2eeAccount,
  openE2eeDatabase,
  saveDraft,
  saveE2eeAccount,
  searchLocalMessages,
  type E2eeAccountRow,
  type StoredE2eeMessage,
} from '@/features/e2ee/db';
import { isE2eeEnabled } from '@/features/e2ee/policy';
import { useSecureScreen } from '@/features/e2ee/screen-security';
import { decryptIncoming, E2eeKeyChangedError, sendEncryptedText } from '@/features/e2ee/text';

function sortMessages(messages: StoredE2eeMessage[]): StoredE2eeMessage[] {
  const seen = new Set<string>();
  return [...messages]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
}

export default function E2eeChatScreen() {
  const params = useLocalSearchParams<{
    id?: string;
    peerId?: string;
    name?: string;
  }>();
  const { token, user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const conversationId = params.id ?? '';
  const peerId = params.peerId ?? '';
  const title = params.name ?? fr.e2eeChat.title;

  // FLAG_SECURE pendant toute la vie de l'écran : la conversation chiffrée
  // n'apparaît jamais en clair dans l'aperçu « applications récentes ».
  useSecureScreen(true);

  const dbRef = useRef<Awaited<ReturnType<typeof openE2eeDatabase>>['db'] | null>(null);
  const accountRef = useRef<E2eeAccountRow | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredE2eeMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StoredE2eeMessage[]>([]);

  const persistAccount = useCallback(async (account: E2eeAccountRow) => {
    accountRef.current = account;
    if (dbRef.current) await saveE2eeAccount(dbRef.current, account);
  }, []);

  const addStored = useCallback((stored: StoredE2eeMessage) => {
    setMessages((previous) =>
      previous.some((item) => item.id === stored.id)
        ? previous
        : sortMessages([...previous, stored]),
    );
  }, []);

  const decryptMessage = useCallback(
    async (message: Message) => {
      if (!token || !dbRef.current || !accountRef.current) return null;
      try {
        const result = await decryptIncoming({
          token,
          db: dbRef.current,
          account: accountRef.current,
          message,
          currentUserId: user?.id ?? '',
        });
        await persistAccount(result.account);
        addStored(result.stored);
        if (result.keyChanged) {
          Alert.alert(fr.e2eeChat.keyChangedTitle, fr.e2eeChat.keyChangedBody);
        }
        return result.stored;
      } catch {
        return null;
      }
    },
    [addStored, persistAccount, token, user?.id],
  );

  // Les déchiffrements doivent se suivre : deux messages simultanés partiraient
  // du même pickle de session et le second échouerait silencieusement.
  const decryptChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const queueDecrypt = useCallback(
    (message: Message) => {
      decryptChainRef.current = decryptChainRef.current
        .then(() => decryptMessage(message))
        .catch(() => undefined);
      return decryptChainRef.current;
    },
    [decryptMessage],
  );

  useEffect(() => {
    if (!isE2eeEnabled() || !token || !user || !conversationId) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const boot = await bootstrapE2ee(token);
        if (boot.recovered) {
          Alert.alert(fr.e2ee.keysLostTitle, fr.e2ee.keysLostBody);
        }
        const opened = await openE2eeDatabase();
        dbRef.current = opened.db;
        const account = await loadE2eeAccount(opened.db);
        if (!account) throw new Error('account_missing');
        accountRef.current = account;
        const storedDraft = await loadDraft(opened.db, conversationId);
        if (!cancelled) setDraft(storedDraft);
        const local = await listLocalMessages(opened.db, conversationId);
        if (!cancelled) setMessages(sortMessages(local));
        const history = await api.listMessages(token, conversationId, { limit: 50 });
        const known = await knownMessageKeys(opened.db, conversationId);
        for (const message of history) {
          if (message.encryption !== 'v1') continue;
          // Un message déjà stocké (ou sa ligne provisoire) ne se relit pas :
          // sa clé de ratchet a déjà été consommée.
          if (known.ids.has(message.id)) continue;
          if (message.clientId && known.clientIds.has(message.clientId)) continue;
          await queueDecrypt(message);
        }
        await api.markRead(token, conversationId).catch(() => undefined);
        if (!cancelled) setReady(true);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : fr.e2eeChat.error);
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, queueDecrypt, token, user]);

  useEffect(() => {
    if (!token || !ready || !isE2eeEnabled()) return;
    const socket = connectSocket(token);
    const onMessage = (message: Message) => {
      if (message.conversationId !== conversationId || message.sender.id === user?.id) return;
      if (message.encryption !== 'v1') return;
      void queueDecrypt(message);
      void api.markRead(token, conversationId).catch(() => undefined);
    };
    socket.on('message:new', onMessage);
    void ensureSocket(token).catch(() => undefined);
    return () => {
      socket.off('message:new', onMessage);
    };
  }, [conversationId, queueDecrypt, ready, token, user?.id]);

  useEffect(() => {
    return () => {
      void dbRef.current?.closeAsync().catch(() => undefined);
      dbRef.current = null;
    };
  }, []);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }
  if (!isE2eeEnabled()) {
    return <Redirect href="/" />;
  }
  if (!conversationId || !peerId) {
    return <Redirect href="/chats" />;
  }

  const conversation: ConversationSummary = {
    id: conversationId,
    type: 'DIRECT',
    name: null,
    avatarUrl: null,
    emoji: null,
    color: null,
    description: null,
    ownerId: null,
    whoCanSend: 'all',
    whoCanAdd: 'all',
    createdAt: '',
    updatedAt: '',
    e2eeSince: new Date().toISOString(),
    members: [
      {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        gender: user.gender,
        lastReadAt: null,
        role: 'member',
      },
      {
        id: peerId,
        username: '',
        displayName: title,
        avatarUrl: null,
        gender: null,
        lastReadAt: null,
        role: 'member',
      },
    ],
    lastMessage: null,
    unreadCount: 0,
    pinned: false,
    muted: false,
    hidden: false,
    myRole: 'member',
    blockedByMe: false,
    blockedByThem: false,
  };

  const send = async (allowKeyChange = false) => {
    const text = draft.trim();
    if (!text || sending || !dbRef.current || !accountRef.current) return;
    setSending(true);
    try {
      const result = await sendEncryptedText({
        token,
        db: dbRef.current,
        account: accountRef.current,
        conversation,
        currentUserId: user.id,
        currentUserName: user.displayName,
        text,
        allowKeyChange,
      });
      addStored(result.stored);
      setDraft('');
      await saveDraft(dbRef.current, conversationId, '');
    } catch (cause) {
      if (cause instanceof E2eeKeyChangedError) {
        Alert.alert(fr.e2eeChat.keyChangedTitle, fr.e2eeChat.keyChangedBody, [
          {
            text: fr.e2eeChat.verifyCode,
            onPress: () =>
              Alert.alert(fr.e2eeChat.verifyCode, cause.signingKey.slice(0, 32), [
                { text: fr.common.close },
              ]),
          },
          {
            text: fr.e2eeChat.sendAnyway,
            style: 'destructive',
            onPress: () => void send(true),
          },
          { text: fr.common.cancel, style: 'cancel' },
        ]);
      } else {
        Alert.alert(fr.e2eeChat.error, cause instanceof Error ? cause.message : '');
      }
    } finally {
      setSending(false);
    }
  };

  const onChangeDraft = (value: string) => {
    setDraft(value);
    if (dbRef.current) void saveDraft(dbRef.current, conversationId, value);
  };

  const runSearch = async (value: string) => {
    setQuery(value);
    if (!dbRef.current || value.trim().length === 0) {
      setResults([]);
      return;
    }
    setResults(await searchLocalMessages(dbRef.current, conversationId, value.trim()));
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => setSearchOpen((open) => !open)} accessibilityRole="button">
          <ThemedText type="smallBold" themeColor="textSecondary">
            {searchOpen ? fr.common.close : fr.e2eeChat.search}
          </ThemedText>
        </Pressable>
      </View>
      {searchOpen ? (
        <View style={styles.searchArea}>
          <TextInput
            value={query}
            onChangeText={(value) => void runSearch(value)}
            placeholder={fr.e2eeChat.searchPlaceholder}
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
            autoFocus
          />
          {results.map((result) => (
            <View key={result.id} style={styles.result}>
              <ThemedText type="small" numberOfLines={2}>
                {result.body}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}
      {error ? (
        <ThemedText type="small" style={styles.error}>
          {fr.e2eeChat.error}: {error}
        </ThemedText>
      ) : null}
      <FlatList
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          ready ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              {fr.e2eeChat.empty}
            </ThemedText>
          ) : undefined
        }
        renderItem={({ item }) => (
          <View
            style={[
              styles.bubble,
              item.mine
                ? { alignSelf: 'flex-end', backgroundColor: theme.accent }
                : { alignSelf: 'flex-start', backgroundColor: theme.backgroundElement },
            ]}>
            <ThemedText style={item.mine ? styles.mineText : undefined}>{item.body}</ThemedText>
          </View>
        )}
      />
      <View style={[styles.composer, { paddingBottom: insets.bottom + Spacing.two }]}>
        <TextInput
          value={draft}
          onChangeText={onChangeDraft}
          placeholder={fr.e2eeChat.placeholder}
          placeholderTextColor={theme.textSecondary}
          multiline
          style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
        />
        <Pressable
          onPress={() => void send()}
          disabled={sending || draft.trim().length === 0}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.send,
            { opacity: sending || !draft.trim() ? 0.5 : pressed ? 0.85 : 1 },
          ]}>
          <LiquidGlass radius={Radii.button} style={styles.sendGlass}>
            <ThemedText style={styles.sendLabel}>{fr.e2eeChat.send}</ThemedText>
          </LiquidGlass>
        </Pressable>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two },
  searchArea: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, gap: Spacing.one },
  result: { paddingVertical: Spacing.two },
  list: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1 },
  empty: { alignSelf: 'center', marginTop: Spacing.five },
  bubble: {
    maxWidth: '82%',
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  mineText: { color: '#ffffff' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  send: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendGlass: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Radii.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendLabel: { color: '#ffffff', fontWeight: '700' },
  error: { color: '#e5484d', paddingHorizontal: Spacing.three },
});
