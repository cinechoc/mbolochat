import { Link, Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/logo';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, PasswordField, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function LoginScreen() {
  const { token, signIn } = useAuth();
  const router = useRouter();
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
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <SafeAreaView style={styles.content}>
          <ThemedView style={styles.brandBlock}>
            <LogoMark size={84} />
            <ThemedText type="subtitle">MboloChat</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.tagline}>
              Messagerie simple, rapide, en temps réel.
            </ThemedText>
          </ThemedView>

          <ThemedView style={styles.form}>
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
              <ThemedText type="small" style={styles.error}>
                {error}
              </ThemedText>
            ) : null}
            <Button title="Se connecter" onPress={onSubmit} loading={submitting} />
          </ThemedView>

          <Link href="/register" style={styles.link}>
            <ThemedText type="link" style={{ color: accentColor }}>
              Pas encore de compte ? Créer un compte
            </ThemedText>
          </Link>
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
    flex: 1,
    paddingHorizontal: Spacing.four,
    justifyContent: 'center',
    gap: Spacing.two,
  },
  brandBlock: {
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.four,
  },
  tagline: {
    textAlign: 'center',
  },
  form: {
    gap: Spacing.three,
  },
  error: {
    color: '#e5484d',
  },
  forgot: {
    alignSelf: 'flex-end',
    marginTop: -Spacing.two,
  },
  link: {
    marginTop: Spacing.four,
    alignSelf: 'center',
  },
});
