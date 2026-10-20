import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAction, ProfileHeader, PhotoGrid } from '@/components/profile-view';
import { SkeletonProfile } from '@/components/skeleton';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { UserProfile } from '@/lib/types';

export default function ProfileScreen() {
  const { token, user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Le profil est connu immédiatement (cache d'authentification) : la page
  // s'affiche sans attente, seules les statistiques se remplissent ensuite.
  const [profile, setProfile] = useState<UserProfile | null>(() =>
    user
      ? {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          bio: user.bio,
          avatarUrl: user.avatarUrl,
          notificationsEnabled: user.notificationsEnabled,
          createdAt: user.createdAt,
          isMe: true,
          stats: { messages: 0, conversations: 0 },
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !user) {
      return;
    }
    try {
      const result = await api.getUserProfile(token, user.id);
      setProfile(result);
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
            <Pressable onPress={() => router.push('/settings')} hitSlop={8}>
              <MaterialIcons name="settings" size={22} color={theme.text} />
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
            actions={
              <ProfileAction
                label="Modifier le profil"
                onPress={() => router.push('/profile/edit')}
              />
            }
          />
        ) : (
          // Le squelette n'apparaît qu'une fraction de seconde : le profil de
          // l'utilisateur courant est déjà connu (cache d'authentification).
          <SkeletonProfile />
        )}

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
