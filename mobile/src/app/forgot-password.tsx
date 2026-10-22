import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LogoMark } from '@/components/logo';
import { Button, PasswordField, TextField, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';

type Step = 'request' | 'reset' | 'done';

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error) {
    return `Erreur inattendue : ${err.message}`;
  }
  return fallback;
}

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const theme = useTheme();
  const keyboardHeight = useKeyboardHeight();
  const [step, setStep] = useState<Step>('request');
  const [identifier, setIdentifier] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onRequest = async () => {
    if (!identifier.trim()) {
      setError('Renseigne ton email ou ton nom d’utilisateur.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.forgotPassword({ emailOrUsername: identifier.trim() });
      setDevCode(result.devCode ?? null);
      setCode('');
      setStep('reset');
    } catch (err) {
      setError(errorMessage(err, 'Envoi du code impossible.'));
    } finally {
      setSubmitting(false);
    }
  };

  const onReset = async () => {
    if (code.trim().length !== 6) {
      setError('Le code contient 6 chiffres.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Le nouveau mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.resetPassword({
        emailOrUsername: identifier.trim(),
        code: code.trim(),
        newPassword,
      });
      setStep('done');
    } catch (err) {
      setError(errorMessage(err, 'Réinitialisation impossible.'));
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
        <SafeAreaView style={styles.content} edges={['bottom']}>
          {step === 'request' ? (
            <>
              <ThemedView style={styles.block}>
                <ThemedView style={styles.brandRow}>
                  <LogoMark size={40} />
                  <ThemedText type="subtitle" style={{ color: accentColor }}>
                    MboloChat
                  </ThemedText>
                </ThemedView>
                <ThemedText themeColor="textSecondary" style={styles.hint}>
                  Indique ton email ou ton nom d’utilisateur pour recevoir un code de
                  réinitialisation à 6 chiffres.
                </ThemedText>
              </ThemedView>
              <ThemedView style={styles.form}>
                <TextField
                  placeholder="Email ou nom d’utilisateur"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={identifier}
                  onChangeText={setIdentifier}
                  onSubmitEditing={onRequest}
                />
                {error ? (
                  <ThemedText type="small" style={{ color: theme.error }}>
                    {error}
                  </ThemedText>
                ) : null}
                <Button title="Envoyer le code" onPress={onRequest} loading={submitting} />
              </ThemedView>
              <Pressable
                onPress={() => router.replace('/login')}
                hitSlop={8}
                style={styles.link}>
                <ThemedText type="link" style={{ color: accentColor }}>
                  Revenir à la connexion
                </ThemedText>
              </Pressable>
            </>
          ) : null}

          {step === 'reset' ? (
            <>
              <ThemedView style={styles.block}>
                <ThemedText type="subtitle">Code de vérification</ThemedText>
                <ThemedText themeColor="textSecondary" style={styles.hint}>
                  Entre le code à 6 chiffres puis choisis un nouveau mot de passe.
                </ThemedText>
              </ThemedView>
              {devCode ? (
                <ThemedView style={[styles.devBox, { backgroundColor: theme.backgroundElement }]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Mode démo (sans serveur e-mail) — ton code :
                  </ThemedText>
                  <ThemedText selectable style={styles.devCode}>
                    {devCode}
                  </ThemedText>
                </ThemedView>
              ) : null}
              <ThemedView style={styles.form}>
                <TextField
                  placeholder="Code à 6 chiffres"
                  keyboardType="number-pad"
                  maxLength={6}
                  value={code}
                  onChangeText={setCode}
                  style={styles.codeInput}
                />
                <PasswordField
                  placeholder="Nouveau mot de passe"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  onSubmitEditing={onReset}
                />
                {error ? (
                  <ThemedText type="small" style={{ color: theme.error }}>
                    {error}
                  </ThemedText>
                ) : null}
                <Button
                  title="Réinitialiser le mot de passe"
                  onPress={onReset}
                  loading={submitting}
                />
              </ThemedView>
              <Pressable
                onPress={() => {
                  setError(null);
                  setStep('request');
                }}
                hitSlop={8}
                style={styles.link}>
                <ThemedText type="link" style={{ color: accentColor }}>
                  Renvoyer un code
                </ThemedText>
              </Pressable>
            </>
          ) : null}

          {step === 'done' ? (
            <>
              <ThemedView style={styles.block}>
                <ThemedText style={styles.checkMark}>✓</ThemedText>
                <ThemedText type="subtitle">Mot de passe modifié</ThemedText>
                <ThemedText themeColor="textSecondary" style={styles.hint}>
                  Tu peux maintenant te connecter avec ton nouveau mot de passe.
                </ThemedText>
              </ThemedView>
              <Button title="Se connecter" onPress={() => router.replace('/login')} />
            </>
          ) : null}
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
    gap: Spacing.three,
  },
  block: {
    alignItems: 'center',
    gap: Spacing.two,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  hint: {
    textAlign: 'center',
  },
  form: {
    gap: Spacing.three,
    marginTop: Spacing.one,
  },
  link: {
    alignSelf: 'center',
    marginTop: Spacing.two,
  },
  devBox: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    alignItems: 'center',
    gap: Spacing.one,
  },
  devCode: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: 6,
    color: accentColor,
  },
  codeInput: {
    textAlign: 'center',
    fontSize: 20,
    letterSpacing: 6,
  },
  checkMark: {
    fontSize: 44,
    lineHeight: 50,
    color: accentColor,
    fontWeight: '800',
  },
});
