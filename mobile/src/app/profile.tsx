import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Settings } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAction, ProfileHeader, PhotoGrid } from '@/components/profile-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import type { UserProfile } from '@/lib/types';

export default function ProfileScreen() {
  const { token, user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Le profil connu (cache mémoire/disque, sinon session) s'affiche tout de
  // suite ; les statistiques se rafraîchissent silencieusement ensuite.
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    if (!user) {
      return null;
    }
    // Profil complet déjà chargé lors d'une visite précédente : affichage
    // instantané, avec les statistiques à jour en arrière-plan.
    const cached = cache.getProfile(user.id);
    if (cached) {
      return cached;
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      gender: user.gender,
      notificationsEnabled: user.notificationsEnabled,
      notificationSound: user.notificationSound ?? true,
      notificationPreview: user.notificationPreview ?? true,
      createdAt: user.createdAt,
      isMe: true,
      stats: { messages: 0, conversations: 0 },
    };
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !user) {
      return;
    }
    try {
      const result = await api.getUserProfile(token, user.id);
      setProfile(result);
      cache.setProfile(result);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger le profil.');
    }
  }, [token, user]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen
        options={{
          title: profile?.username ?? user.username,
          // Bouton réglages dans la barre de navigation, comme sur Instagram.
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Paramètres">
              <Settings size={22} color={theme.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + Spacing.four },
        ]}
        keyboardShouldPersistTaps="handled">
        {profile ? (
          <ProfileHeader
            profile={profile}
            showUsername
            actions={
              <ProfileAction
                label="Modifier le profil"
                onPress={() => router.push('/profile/edit')}
              />
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
