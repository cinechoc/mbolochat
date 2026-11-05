import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BlurTarget } from '@/components/blur-target';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LogoMark } from '@/components/logo';
import { AuthSurface, Button, PasswordField, TextField } from '@/components/ui';
import { Colors, Spacing, Radii } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
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
      lightColor={AuthSurface.background}
      darkColor={AuthSurface.background}
      style={[
        styles.container,
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <SafeAreaView style={styles.flex} edges={['bottom']}>
          <BlurTarget style={styles.flex}>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
          {step === 'request' ? (
            <>
              <ThemedView style={styles.block}>
                <ThemedView style={styles.brandRow}>
                  <LogoMark size={40} />
                  <ThemedText type="subtitle" style={{ color: AuthSurface.accent }}>
                    MboloChat
                  </ThemedText>
                </ThemedView>
                <ThemedText style={[styles.hint, { color: AuthSurface.subtle }]}>
                  Indique ton email ou ton nom d’utilisateur pour recevoir un code de
                  réinitialisation à 6 chiffres.
                </ThemedText>
              </ThemedView>
              <ThemedView style={styles.form}>
                <TextField
                  glass
                  placeholder="Email ou nom d’utilisateur"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={identifier}
                  onChangeText={setIdentifier}
                  onSubmitEditing={onRequest}
                />
                {error ? (
                  <ThemedText type="small" style={{ color: Colors.dark.error }}>
                    {error}
                  </ThemedText>
                ) : null}
                <Button glass title="Envoyer le code" onPress={onRequest} loading={submitting} />
              </ThemedView>
              <Pressable
                onPress={() => router.replace('/login')}
                hitSlop={8}
                style={styles.link}>
                <ThemedText type="link" style={{ color: AuthSurface.accent }}>
                  Revenir à la connexion
                </ThemedText>
              </Pressable>
            </>
          ) : null}

          {step === 'reset' ? (
            <>
              <ThemedView style={styles.block}>
                <ThemedText type="subtitle" style={{ color: AuthSurface.text }}>
                  Code de vérification
                </ThemedText>
                <ThemedText style={[styles.hint, { color: AuthSurface.subtle }]}>
                  Entre le code à 6 chiffres puis choisis un nouveau mot de passe.
                </ThemedText>
              </ThemedView>
              {devCode ? (
                <ThemedView style={[styles.devBox, { backgroundColor: AuthSurface.glassField }]}>
                  <ThemedText type="small" style={{ color: AuthSurface.subtle }}>
                    Mode démo (sans serveur e-mail) — ton code :
                  </ThemedText>
                  <ThemedText selectable style={styles.devCode}>
                    {devCode}
                  </ThemedText>
                </ThemedView>
              ) : null}
              <ThemedView style={styles.form}>
                <TextField
                  glass
                  placeholder="Code à 6 chiffres"
                  keyboardType="number-pad"
                  maxLength={6}
                  value={code}
                  onChangeText={setCode}
                  style={styles.codeInput}
                />
                <PasswordField
                  glass
                  placeholder="Nouveau mot de passe"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  onSubmitEditing={onReset}
                />
                {error ? (
                  <ThemedText type="small" style={{ color: Colors.dark.error }}>
                    {error}
                  </ThemedText>
                ) : null}
                <Button
                  glass
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
                <ThemedText type="link" style={{ color: AuthSurface.accent }}>
                  Renvoyer un code
                </ThemedText>
              </Pressable>
            </>
          ) : null}

          {step === 'done' ? (
            <>
              <ThemedView style={styles.block}>
                <Check size={44} strokeWidth={2.6} color={AuthSurface.accent} />
                <ThemedText type="subtitle" style={{ color: AuthSurface.text }}>
                  Mot de passe modifié
                </ThemedText>
                <ThemedText style={[styles.hint, { color: AuthSurface.subtle }]}>
                  Tu peux maintenant te connecter avec ton nouveau mot de passe.
                </ThemedText>
              </ThemedView>
              <Button glass title="Se connecter" onPress={() => router.replace('/login')} />
            </>
          ) : null}
          </ScrollView>
          </BlurTarget>
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
    borderRadius: Radii.md,
    padding: Spacing.three,
    alignItems: 'center',
    gap: Spacing.one,
  },
  devCode: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: 6,
    color: AuthSurface.accent,
  },
  codeInput: {
    textAlign: 'center',
    fontSize: 20,
    letterSpacing: 6,
  },
});
