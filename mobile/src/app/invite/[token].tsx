import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { InvitePreview } from '@/lib/types';

const STATUS_TEXT: Record<string, string> = {
  expired: 'Ce lien d’invitation a expiré.',
  revoked: 'Ce lien d’invitation a été révoqué.',
  exhausted: 'Ce lien a atteint son nombre maximum d’utilisations.',
  full: 'Ce groupe est complet.',
};

/** Écran public d'une invitation : aperçu du groupe, puis entrée ou connexion. */
export default function InviteScreen() {
  const { token: inviteToken } = useLocalSearchParams<{ token: string }>();
  const { token } = useAuth();
  const theme = useTheme();
  const bottomInset = useBottomInset();
  const router = useRouter();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    let active = true;
    api
      .previewInvite(inviteToken)
      .then((result) => {
        if (active) {
          setPreview(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof ApiError && err.status === 404
              ? 'Cette invitation n’existe pas ou plus.'
              : err instanceof ApiError
                ? err.message
                : 'Impossible de charger l’invitation.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [inviteToken]);

  const join = async () => {
    if (!token || !inviteToken) return;
    setJoining(true);
    setError(null);
    try {
      const result = await api.joinInvite(token, inviteToken);
      if (result.status === 'pending') {
        setPending(true);
        return;
      }
      router.replace({ pathname: '/chat/[id]', params: { id: result.conversationId } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de rejoindre le groupe.');
    } finally {
      setJoining(false);
    }
  };

  const loginWithReturn = () => {
    if (!inviteToken) return;
    router.push({ pathname: '/login', params: { next: `/invite/${inviteToken}` } });
  };

  if (!preview && !error) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  const groupName = preview?.group.name?.trim() || 'Groupe';
  const blocked = preview && preview.status !== 'ok';

  return (
    <ThemedView style={[styles.container, { paddingBottom: bottomInset }]}>
      {preview ? (
        <>
          <Avatar
            name={groupName}
            uri={preview.group.avatarUrl}
            emoji={preview.group.emoji}
            color={preview.group.color}
            variant="group"
            size={104}
          />
          <ThemedText style={styles.title}>{groupName}</ThemedText>
          {preview.group.description ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.description}>
              {preview.group.description}
            </ThemedText>
          ) : null}
          <ThemedText type="small" themeColor="textSecondary">
            {preview.group.memberCount} membre{preview.group.memberCount > 1 ? 's' : ''}
            {preview.requiresApproval ? ' · entrée sur approbation' : ''}
          </ThemedText>
        </>
      ) : null}

      {error ? (
        <ThemedText style={[styles.message, { color: theme.error }]}>{error}</ThemedText>
      ) : null}

      {blocked ? (
        <ThemedText style={[styles.message, { color: theme.error }]}>
          {STATUS_TEXT[preview.status] ?? 'Cette invitation n’est plus valable.'}
        </ThemedText>
      ) : null}

      {pending ? (
        <ThemedText style={styles.message}>
          Demande envoyée. Un administrateur doit l’approuver avant ton entrée.
        </ThemedText>
      ) : null}

      {preview && !blocked && !pending ? (
        <View style={styles.actions}>
          {token ? (
            <Button title="Rejoindre le groupe" onPress={() => void join()} loading={joining} />
          ) : (
            <Button title="Se connecter pour rejoindre" onPress={loginWithReturn} />
          )}
          <Button title="Plus tard" variant="secondary" onPress={() => router.replace('/chats')} />
        </View>
      ) : (
        <View style={styles.actions}>
          <Button title="Plus tard" variant="secondary" onPress={() => router.replace('/chats')} />
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700', textAlign: 'center' },
  description: { textAlign: 'center' },
  message: { textAlign: 'center' },
  actions: { width: '100%', gap: Spacing.two, marginTop: Spacing.two },
});
