import { Redirect, Stack, useRouter } from 'expo-router';
import { Shield } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/** Changement de mot de passe : vérifie l'ancien, déconnecte les sessions. */
export default function SecurityScreen() {
  const { token, signOut } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  if (!token) {
    return <Redirect href="/login" />;
  }

  const submit = async () => {
    if (!token || busy) return;
    if (next.length < 8) {
      Alert.alert('Mot de passe trop court', 'Utilisez au moins 8 caractères.');
      return;
    }
    if (next !== confirm) {
      Alert.alert('Confirmation différente', 'Les deux nouveaux mots de passe ne correspondent pas.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(token, current, next);
      Alert.alert(
        'Mot de passe modifié',
        'Toutes les sessions ont été déconnectées. Reconnectez-vous avec votre nouveau mot de passe.',
        [{ text: 'Se reconnecter', onPress: () => void signOut() }],
      );
    } catch (cause) {
      Alert.alert(
        'Modification impossible',
        cause instanceof ApiError ? cause.message : 'Réessayez plus tard.',
      );
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [
    styles.input,
    { color: theme.text, backgroundColor: theme.backgroundElement },
  ];

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.security }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={styles.header}>
          <Shield size={28} color={theme.accent} />
          <ThemedText type="sectionTitle">Mot de passe</ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          Le changement déconnecte les autres appareils. Utilisez un mot de passe unique.
        </ThemedText>
        <TextInput
          value={current}
          onChangeText={setCurrent}
          placeholder="Mot de passe actuel"
          placeholderTextColor={theme.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          style={inputStyle}
        />
        <TextInput
          value={next}
          onChangeText={setNext}
          placeholder="Nouveau mot de passe"
          placeholderTextColor={theme.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          style={inputStyle}
        />
        <TextInput
          value={confirm}
          onChangeText={setConfirm}
          placeholder="Confirmer le nouveau mot de passe"
          placeholderTextColor={theme.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          style={inputStyle}
        />
        <Pressable
          onPress={() => void submit()}
          disabled={busy}
          style={({ pressed }) => [
            styles.submit,
            { backgroundColor: theme.accent, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
          ]}>
          <ThemedText style={styles.submitLabel}>
            {busy ? 'Modification…' : 'Modifier le mot de passe'}
          </ThemedText>
        </Pressable>
        <Pressable onPress={() => router.back()} style={styles.cancel}>
          <ThemedText type="small" themeColor="textSecondary">
            {fr.common.cancel}
          </ThemedText>
        </Pressable>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  input: {
    minHeight: 48,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
  },
  submit: {
    minHeight: 48,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  submitLabel: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
  cancel: { alignSelf: 'center', padding: Spacing.two },
});
