import { Redirect, Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { conversationTitle, formatDateLabel, formatTime } from '@/lib/format';
import { connectSocket, disconnectSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';

type ListRow =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'message'; message: Message };

function ChatHeaderTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.headerTitle}>
      <Avatar name={title} size={36} />
      <View style={styles.headerTitleBody}>
        <ThemedText numberOfLines={1} style={styles.headerName}>
          {title}
        </ThemedText>
        {subtitle ? (
          <ThemedText numberOfLines={1} type="small" themeColor="textSecondary" style={styles.headerSubtitle}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { token, user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ListRow>>(null);

  useEffect(() => {
    if (!token || !id) {
      return;
    }
    let active = true;
    (async () => {
      try {
        const [summary, history] = await Promise.all([
          api.getConversation(token, id),
          api.listMessages(token, id),
        ]);
        if (active) {
          setConversation(summary);
          setMessages(history);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof ApiError ? err.message : 'Impossible de charger la discussion.');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [token, id]);

  useEffect(() => {
    if (!token || !id) {
      return;
    }
    const socket = connectSocket(token);

    const join = () => {
      socket.emit('conversation:join', { conversationId: id });
    };
    const onMessage = (message: Message) => {
      if (message.conversationId !== id) {
        return;
      }
      setMessages((previous) =>
        previous.some((existing) => existing.id === message.id)
          ? previous
          : [...previous, message],
      );
    };

    socket.on('message:new', onMessage);
    if (socket.connected) {
      join();
    } else {
      socket.on('connect', join);
    }

    return () => {
      socket.off('message:new', onMessage);
      socket.off('connect', join);
      disconnectSocket();
    };
  }, [token, id]);

  const rows = useMemo(() => {
    const chronological: ListRow[] = [];
    let lastLabel = '';
    for (const message of messages) {
      const label = formatDateLabel(message.createdAt);
      if (label !== lastLabel) {
        chronological.push({ key: `date-${message.id}`, type: 'date', label });
        lastLabel = label;
      }
      chronological.push({ key: message.id, type: 'message', message });
    }
    return chronological.reverse();
  }, [messages]);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const title = conversation ? conversationTitle(conversation, user.id) : '';
  const isGroup = Boolean(conversation?.name);
  const other = conversation?.members.find((member) => member.id !== user.id);
  const subtitle = isGroup
    ? `${conversation?.members.length ?? 0} membres`
    : other
      ? `@${other.username}`
      : '';

  const send = async () => {
    const content = input.trim();
    if (!content || !token || !id) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const socket = connectSocket(token);
      await socket.emitWithAck('message:send', { conversationId: id, content });
      setInput('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "L'envoi a échoué. Réessaie.");
    } finally {
      setSending(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen
        options={{
          headerTitle: () => <ChatHeaderTitle title={title} subtitle={subtitle} />,
          headerRight: () =>
            conversation?.type === 'GROUP' ? (
              <Pressable onPress={() => router.push({ pathname: '/conversation-settings/[id]', params: { id } })}>
                <ThemedText style={{ color: accentColor, fontWeight: '600' }}>Infos</ThemedText>
              </Pressable>
            ) : null,
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        style={styles.flex}>
        {loading ? (
          <ThemedView style={styles.center}>
            <ActivityIndicator size="large" />
          </ThemedView>
        ) : (
          <FlatList
            ref={listRef}
            data={rows}
            inverted
            keyExtractor={(item) => item.key}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => listRef.current?.scrollToOffset({ offset: 0, animated: false })}
            ListEmptyComponent={
              <ThemedView style={styles.center}>
                <ThemedText themeColor="textSecondary" style={styles.emptyText}>
                  Aucun message. Dis bonjour !
                </ThemedText>
              </ThemedView>
            }
            renderItem={({ item }) => {
              if (item.type === 'date') {
                return (
                  <View style={styles.dateRow}>
                    <ThemedView
                      style={[styles.datePill, { backgroundColor: theme.backgroundElement }]}>
                      <ThemedText
                        type="small"
                        themeColor="textSecondary"
                        style={styles.dateText}>
                        {item.label}
                      </ThemedText>
                    </ThemedView>
                  </View>
                );
              }
              const { message } = item;
              const mine = message.sender.id === user.id;
              return (
                <View style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}>
                  <View
                    style={[
                      styles.bubble,
                      mine
                        ? styles.bubbleMine
                        : { backgroundColor: theme.backgroundElement, borderBottomLeftRadius: 6 },
                    ]}>
                    {!mine && isGroup ? (
                      <ThemedText type="smallBold" style={styles.senderName}>
                        {message.sender.displayName}
                      </ThemedText>
                    ) : null}
                    <ThemedText style={mine ? styles.bubbleTextMine : undefined}>
                      {message.content}
                    </ThemedText>
                    <View style={styles.metaRow}>
                      <ThemedText
                        style={[
                          styles.metaText,
                          mine ? styles.metaTextMine : { color: theme.textSecondary },
                        ]}>
                        {formatTime(message.createdAt)}
                      </ThemedText>
                      {mine ? <ThemedText style={[styles.metaText, styles.metaTextMine]}>✓✓</ThemedText> : null}
                    </View>
                  </View>
                </View>
              );
            }}
          />
        )}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        <ThemedView
          style={[
            styles.inputRow,
            {
              paddingBottom: Math.max(insets.bottom, Spacing.three),
              borderTopColor: theme.backgroundElement,
            },
          ]}>
          <TextField
            style={styles.input}
            placeholder="Écrire un message..."
            value={input}
            multiline
            onChangeText={setInput}
            onSubmitEditing={send}
          />
          <Pressable
            onPress={send}
            disabled={sending || input.trim().length === 0}
            style={({ pressed }) => [
              styles.sendButton,
              (pressed || sending || input.trim().length === 0) && styles.sendDisabled,
            ]}>
            {sending ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <ThemedText style={styles.sendIcon}>➤</ThemedText>
            )}
          </Pressable>
        </ThemedView>
      </KeyboardAvoidingView>
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
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerTitleBody: {
    maxWidth: 220,
  },
  headerName: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '600',
  },
  headerSubtitle: {
    fontSize: 12,
    lineHeight: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  emptyText: {
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    flexGrow: 1,
  },
  bubbleRow: {
    flexDirection: 'row',
    marginVertical: Spacing.half,
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  rowTheirs: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: Spacing.half,
  },
  bubbleMine: {
    backgroundColor: accentColor,
    borderBottomRightRadius: 6,
  },
  bubbleTextMine: {
    color: '#ffffff',
  },
  senderName: {
    color: accentColor,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: Spacing.one,
  },
  metaText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
  },
  metaTextMine: {
    color: '#d7e6ff',
  },
  dateRow: {
    alignItems: 'center',
    marginVertical: Spacing.two,
  },
  datePill: {
    borderRadius: 999,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.half,
  },
  dateText: {
    fontSize: 12,
    lineHeight: 16,
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.one,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    paddingTop: 12,
    paddingBottom: 12,
    maxHeight: 120,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: accentColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: {
    opacity: 0.45,
  },
  sendIcon: {
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 20,
    marginLeft: 2,
  },
});
