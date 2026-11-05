import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { Settings } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAction, ProfileHeader } from '@/components/profile-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import type { UserProfile } from '@/lib/types';

export default function ProfileScreen() {
  const { token, user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    if (!user) {
      return null;
    }
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
      genderCustom: user.genderCustom,
      notificationsEnabled: user.notificationsEnabled,
      notificationSound: user.notificationSound ?? true,
      notificationPreview: user.notificationPreview ?? true,
      createdAt: user.createdAt,
      isMe: true,
      age: null,
      city: null,
      country: null,
      birthdateSet: false,
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
          title: 'Profil',
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
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}
        keyboardShouldPersistTaps="handled">
        {profile ? (
          <ProfileHeader
            profile={profile}
            actions={
              <View style={styles.actions}>
                <ProfileAction
                  label={fr.profile.edit}
                  onPress={() => router.push('/profile/edit')}
                  primary
                />
                {!profile.birthdateSet ? (
                  <ProfileAction
                    label="Renseigner ma date de naissance"
                    onPress={() => router.push('/profile/birthdate')}
                  />
                ) : null}
              </View>
            }
          />
        ) : null}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.four,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  error: { color: '#e5484d' },
});
