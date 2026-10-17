import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField } from '@/components/ui';
import { Spacing } from '@/constants/theme';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function ProfileScreen() {
  const { token, user, setUser } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateProfile(token, { displayName: displayName.trim() });
      setUser(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  };

  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Permission refusée pour la galerie.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    if (!asset.base64) return;
    setUploading(true);
    setError(null);
    try {
      const updated = await api.uploadAvatar(token, asset.base64, asset.mimeType ?? 'image/jpeg');
      setUser(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload impossible.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.card}>
        <Pressable onPress={pickAvatar} style={styles.avatarWrap}>
          <Avatar name={user.displayName} uri={user.avatarUrl} size={96} />
          {uploading ? (
            <ThemedView style={styles.avatarOverlay}>
              <ActivityIndicator color="#fff" />
            </ThemedView>
          ) : null}
        </Pressable>
        <ThemedText type="small" themeColor="textSecondary">
          Appuie sur la photo pour la changer
        </ThemedText>

        <ThemedView style={styles.field}>
          <ThemedText type="smallBold">Nom affiché</ThemedText>
          <TextField value={displayName} onChangeText={setDisplayName} />
        </ThemedView>

        <ThemedText type="small" themeColor="textSecondary">
          @{user.username}
        </ThemedText>

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        <ThemedView style={styles.actions}>
          <Button title="Enregistrer" onPress={save} loading={saving} />
          <Button title="Fermer" variant="secondary" onPress={() => router.back()} />
        </ThemedView>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: Spacing.four, justifyContent: 'center' },
  card: { alignItems: 'center', gap: Spacing.three },
  avatarWrap: { position: 'relative' },
  avatarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 48,
  },
  field: { alignSelf: 'stretch', gap: Spacing.one },
  actions: { alignSelf: 'stretch', gap: Spacing.two },
  error: { color: '#e5484d' },
});
