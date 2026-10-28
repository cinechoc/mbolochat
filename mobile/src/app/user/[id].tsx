import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAction, ProfileHeader, PhotoGrid } from '@/components/profile-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import type { Gender, UserProfile } from '@/lib/types';

export default function UserProfileScreen() {
  // Le nom et la photo sont passés par l'écran appelant (liste, chat) : le
  // profil s'affiche ainsi instantanément, avant même la réponse du serveur.
  const { id, name, username, avatar, gender: genderParam } = useLocalSearchParams<{
    id: string;
    name?: string;
    username?: string;
    avatar?: string;
    gender?: string;
  }>();
  const initialGender: Gender | null =
    genderParam === 'MALE' || genderParam === 'FEMALE' || genderParam === 'CUSTOM'
      ? genderParam
      : null;
  const { token, user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [profile, setProfile] = useState<UserProfile | null>(() => {
    if (!id) {
      return null;
    }
    const cached = cache.getProfile(id);
    if (cached) {
      return cached;
    }
    if (!name || !username) {
      return null;
    }
    return {
      id,
      username,
      displayName: name,
      bio: null,
      avatarUrl: avatar ? avatar : null,
      gender: initialGender,
      notificationsEnabled: true,
      notificationSound: true,
      notificationPreview: true,
      createdAt: '',
      isMe: false,
      stats: { messages: 0, conversations: 0 },
    };
  });
  const [starting, setStarting] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !id) {
      return;
    }
    try {
      const [result, blockedUsers] = await Promise.all([
        api.getUserProfile(token, id),
        api.listBlockedUsers(token),
      ]);
      setProfile(result);
      cache.setProfile(result);
      setBlocked(blockedUsers.some((item) => item.id === id));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger ce profil.');
    }
  }, [token, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const startConversation = async () => {
    if (!token || !profile) {
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const conversation = await api.createConversation(token, { memberIds: [profile.id] });
      router.replace({ pathname: '/chat/[id]', params: { id: conversation.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible d’ouvrir la discussion.');
      setStarting(false);
    }
  };

  const toggleBlock = async () => {
    if (!token || !profile) {
      return;
    }
    try {
      if (blocked) {
        await api.unblockUser(token, profile.id);
      } else {
        await api.blockUser(token, profile.id);
      }
      setBlocked(!blocked);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action impossible.');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: profile?.displayName ?? name ?? 'Profil' }} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + Spacing.four },
        ]}>
        {profile ? (
          <ProfileHeader
            profile={profile}
            showUsername={profile.isMe}
            actions={
              profile.isMe ? (
                <ProfileAction
                  label="Modifier le profil"
                  onPress={() => router.push('/profile/edit')}
                />
              ) : blocked ? (
                <ProfileAction
                  label="Débloquer le compte"
                  onPress={() => void toggleBlock()}
                  primary
                />
              ) : (
                <>
                  <ProfileAction
                    label="Envoyer un message"
                    onPress={() => void startConversation()}
                    loading={starting}
                    primary
                  />
                  <ProfileAction
                    label="Bloquer le compte"
                    onPress={() => void toggleBlock()}
                    danger
                  />
                </>
              )
            }
          />
        ) : null}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        <View style={styles.section}>
          <ThemedText style={styles.sectionTitle}>Photos</ThemedText>
          <PhotoGrid photos={[]} />
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.four,
  },
  error: {
    color: '#e5484d',
  },
  section: {
    gap: Spacing.three,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 22,
  },
});
