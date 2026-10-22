import { Link, Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { LogoMark } from '@/components/logo';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, PasswordField, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function LoginScreen() {
  const { token, signIn } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const keyboardHeight = useKeyboardHeight();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (token) {
    return <Redirect href="/chats" />;
  }

  const onSubmit = async () => {
    if (!identifier.trim() || !password) {
      setError('Renseigne ton email (ou nom d’utilisateur) et ton mot de passe.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.login({ emailOrUsername: identifier.trim(), password });
      await signIn(result.accessToken, result.refreshToken, result.user);
      router.replace('/chats');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? `Erreur inattendue : ${err.message}`
            : 'Connexion impossible.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ThemedView
      style={[
        styles.container,
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <SafeAreaView style={styles.flex}>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <Animated.View entering={FadeInUp.duration(520)} style={styles.brandBlock}>
              <ThemedView style={styles.brandRow}>
                <LogoMark size={48} />
                <ThemedText type="subtitle">MboloChat</ThemedText>
              </ThemedView>
              <ThemedText themeColor="textSecondary" style={styles.tagline}>
                Messagerie simple, rapide, en temps réel.
              </ThemedText>
            </Animated.View>

            <Animated.View entering={FadeInUp.duration(520).delay(120)} style={styles.form}>
              <TextField
                placeholder="Email ou nom d’utilisateur"
                autoCapitalize="none"
                autoCorrect={false}
                value={identifier}
                onChangeText={setIdentifier}
              />
              <PasswordField
                placeholder="Mot de passe"
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={onSubmit}
              />
              <Pressable
                onPress={() => router.push('/forgot-password')}
                hitSlop={8}
                style={styles.forgot}>
                <ThemedText type="link" style={{ color: accentColor }}>
                  Mot de passe oublié ?
                </ThemedText>
              </Pressable>
              {error ? (
                <ThemedText type="small" style={{ color: theme.error }}>
                  {error}
                </ThemedText>
              ) : null}
              <Button title="Se connecter" onPress={onSubmit} loading={submitting} />
            </Animated.View>

            <Link href="/register" style={styles.link}>
              <ThemedText type="link" style={{ color: accentColor }}>
                Pas encore de compte ? Créer un compte
              </ThemedText>
            </Link>
          </ScrollView>
        </SafeAreaView>
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
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    justifyContent: 'center',
    gap: Spacing.three,
  },
  brandBlock: {
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  tagline: {
    textAlign: 'center',
  },
  form: {
    gap: Spacing.three,
  },
  forgot: {
    alignSelf: 'flex-end',
    marginTop: -Spacing.one,
  },
  link: {
    marginTop: Spacing.three,
    alignSelf: 'center',
  },
});
