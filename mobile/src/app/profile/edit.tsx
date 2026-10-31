import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing, Radii } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const BIO_MAX_LENGTH = 160;

/** Page « Modifier le profil », sur le modèle d'Instagram. */
export default function EditProfileScreen() {
  const { token, user, setUser } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ displayName?: string; bio?: string }>();

  const [displayName, setDisplayName] = useState(params.displayName ?? user?.displayName ?? '');
  const [bio, setBio] = useState(params.bio ?? user?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!token || !user) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateProfile(token, {
        displayName: displayName.trim() || user.displayName,
        bio: bio.trim(),
      });
      setUser(updated);
      router.back();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  }, [token, user, displayName, bio, setUser, router]);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const pickAvatar = async () => {
    if (uploading || deleting) {
      return;
    }
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
    if (result.canceled || !result.assets?.[0]?.base64) {
      return;
    }
    const asset = result.assets[0];
    if (!asset.base64) {
      return;
    }
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

  const removeAvatar = async () => {
    if (!token || !user?.avatarUrl || deleting || uploading) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const updated = await api.deleteAvatar(token);
      setUser(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Suppression impossible.');
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeleteAvatar = () => {
    if (!user?.avatarUrl || deleting || uploading) {
      return;
    }
    Alert.alert(
      'Supprimer la photo ?',
      'Ton avatar par défaut sera affiché à la place.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => void removeAvatar() },
      ],
    );
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Modifier le profil',
          headerRight: () => (
            <Pressable
              onPress={() => void save()}
              hitSlop={8}
              disabled={saving || uploading || deleting}>
              <ThemedText style={styles.save}>{saving ? '…' : 'Enregistrer'}</ThemedText>
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
        <View style={styles.photoRow}>
          <Avatar
            name={user.displayName}
            uri={user.avatarUrl}
            size={86}
            gender={user.gender}
          />
          <View style={styles.photoActions}>
            <Pressable
              onPress={() => void pickAvatar()}
              disabled={uploading || deleting}>
              <ThemedText style={styles.changePhoto}>
                {uploading ? 'Envoi…' : 'Changer la photo'}
              </ThemedText>
            </Pressable>
            {user.avatarUrl ? (
              <Pressable
                onPress={confirmDeleteAvatar}
                disabled={uploading || deleting}
                hitSlop={6}>
                <ThemedText style={styles.deletePhoto}>
                  {deleting ? 'Suppression…' : 'Supprimer la photo'}
                </ThemedText>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.field}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Nom
          </ThemedText>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Ton nom"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.input,
              { backgroundColor: theme.backgroundElement, color: theme.text },
            ]}
          />
        </View>

        <View style={styles.field}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Nom d&apos;utilisateur
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={[
              styles.input,
              styles.readonly,
              { backgroundColor: theme.backgroundElement, color: theme.textSecondary },
            ]}>
            @{user.username}
          </ThemedText>
        </View>

        <View style={styles.field}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Biographie
          </ThemedText>
          <TextInput
            value={bio}
            onChangeText={(value) => setBio(value.slice(0, BIO_MAX_LENGTH))}
            placeholder="Parle un peu de toi"
            placeholderTextColor={theme.textSecondary}
            multiline
            numberOfLines={4}
            style={[
              styles.input,
              styles.bioInput,
              { backgroundColor: theme.backgroundElement, color: theme.text },
            ]}
          />
          <ThemedText type="small" themeColor="textSecondary">
            {bio.length}/{BIO_MAX_LENGTH}
          </ThemedText>
        </View>

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
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  photoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.four,
    paddingBottom: Spacing.two,
  },
  photoActions: {
    flex: 1,
    gap: Spacing.two,
  },
  changePhoto: {
    color: '#3c87f7',
    fontWeight: '700',
    fontSize: 15,
  },
  deletePhoto: {
    color: '#e5484d',
    fontWeight: '600',
    fontSize: 14,
  },
  field: {
    gap: Spacing.one,
  },
  input: {
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
  readonly: {
    opacity: 0.8,
  },
  bioInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  save: {
    color: '#3c87f7',
    fontWeight: '700',
    fontSize: 16,
  },
  error: {
    color: '#e5484d',
  },
});
