import { Link, Redirect, useRouter } from 'expo-router';
import { useRef, useMemo, useState, type ComponentRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { BlurTarget } from '@/components/blur-target';
import { Select, type SelectOption } from '@/components/select';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AuthSurface, Button, PasswordField, TextField, accentColor } from '@/components/ui';
import { Colors, Spacing, Radii } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { Gender } from '@/lib/types';

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'FEMALE', label: 'Femme' },
  { value: 'MALE', label: 'Homme' },
  { value: 'CUSTOM', label: 'Personnalisé' },
];

export default function RegisterScreen() {
  const { token, signIn } = useAuth();
  const router = useRouter();
  const keyboardHeight = useKeyboardHeight();
  /** Cible du flou Android : le fond qui défile derrière les surfaces en verre. */
  const blurTargetRef = useRef<ComponentRef<typeof View>>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [year, setYear] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender | null>(null);
  const [genderCustom, setGenderCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dayOptions = useMemo<SelectOption[]>(
    () =>
      Array.from({ length: 31 }, (_, index) => {
        const value = String(index + 1);
        return { label: value, value };
      }),
    [],
  );
  const monthOptions = useMemo<SelectOption[]>(
    () => MONTHS.map((label, index) => ({ label, value: String(index + 1) })),
    [],
  );
  const yearOptions = useMemo<SelectOption[]>(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 88 }, (_, index) => {
      const value = String(currentYear - 13 - index);
      return { label: value, value };
    });
  }, []);

  if (token) {
    return <Redirect href="/chats" />;
  }

  const onSubmit = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      setError('Indique ton prénom et ton nom.');
      return;
    }
    if (!email.trim()) {
      setError('Indique ton adresse e-mail.');
      return;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (!day || !month || !year) {
      setError('Sélectionne ta date de naissance (jour, mois et année).');
      return;
    }
    if (!gender) {
      setError('Sélectionne un genre.');
      return;
    }
    const customGender = genderCustom.trim();
    if (gender === 'CUSTOM' && !customGender) {
      setError('Indique ton genre personnalisé.');
      return;
    }

    const dayNumber = Number(day);
    const monthNumber = Number(month);
    const yearNumber = Number(year);
    const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
    if (
      date.getUTCFullYear() !== yearNumber ||
      date.getUTCMonth() !== monthNumber - 1 ||
      date.getUTCDate() !== dayNumber
    ) {
      setError("Cette date de naissance n'existe pas.");
      return;
    }

    const birthday = `${yearNumber}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.register({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        password,
        birthday,
        gender,
        genderCustom: gender === 'CUSTOM' ? customGender : undefined,
      });
      await signIn(result.accessToken, result.refreshToken, result.user);
      router.replace('/chats');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? `Erreur inattendue : ${err.message}`
            : 'Inscription impossible.',
      );
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
        <SafeAreaView style={styles.flex}>
          <BlurTarget ref={blurTargetRef} style={styles.flex}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <ThemedText type="small" style={[styles.intro, { color: AuthSurface.subtle }]}>
              Créer un compte — c&apos;est rapide et facile.
            </ThemedText>
            <Animated.View entering={FadeInUp.duration(520).delay(120)} style={styles.form}>
            <ThemedView style={styles.nameRow}>
              <TextField
                glass
                blurTarget={blurTargetRef}
                style={styles.flex}
                placeholder="Prénom"
                autoCapitalize="words"
                value={firstName}
                onChangeText={setFirstName}
              />
              <TextField
                glass
                blurTarget={blurTargetRef}
                style={styles.flex}
                placeholder="Nom de famille"
                autoCapitalize="words"
                value={lastName}
                onChangeText={setLastName}
              />
            </ThemedView>

            <TextField
              glass
              blurTarget={blurTargetRef}
              placeholder="Adresse e-mail"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <PasswordField
              glass
              blurTarget={blurTargetRef}
              placeholder="Nouveau mot de passe"
              value={password}
              onChangeText={setPassword}
            />

            <ThemedView style={styles.birthdaySection}>
              <ThemedText type="smallBold" style={{ color: AuthSurface.subtle }}>
                Date de naissance
              </ThemedText>
              <ThemedView style={styles.birthdayRow}>
                <Select
                  glass
                  style={styles.flex}
                  placeholder="Jour"
                  options={dayOptions}
                  value={day}
                  onChange={setDay}
                />
                <Select
                  glass
                  style={styles.flex}
                  placeholder="Mois"
                  options={monthOptions}
                  value={month}
                  onChange={setMonth}
                />
                <Select
                  glass
                  style={styles.flex}
                  placeholder="Année"
                  options={yearOptions}
                  value={year}
                  onChange={setYear}
                />
              </ThemedView>
            </ThemedView>

            <ThemedView style={styles.genderSection}>
              <ThemedText type="smallBold" style={{ color: AuthSurface.subtle }}>
                Genre
              </ThemedText>
              <ThemedView style={styles.genderRow}>
                {GENDER_OPTIONS.map((option) => {
                  const selected = gender === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setGender(option.value)}
                      style={({ pressed }) => [
                        styles.genderOption,
                        {
                          backgroundColor: selected ? accentColor : 'transparent',
                          borderColor: AuthSurface.border,
                        },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText
                        type="small"
                        style={
                          selected
                            ? styles.genderSelectedText
                            : { color: AuthSurface.text }
                        }>
                        {option.label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </ThemedView>
              {gender === 'CUSTOM' ? (
                <TextField
                  glass
                  blurTarget={blurTargetRef}
                  placeholder="Ton genre (ex. Non-binaire)"
                  autoCapitalize="sentences"
                  maxLength={32}
                  value={genderCustom}
                  onChangeText={setGenderCustom}
                />
              ) : null}
            </ThemedView>

            <ThemedText type="small" style={[styles.terms, { color: AuthSurface.subtle }]}>
              En cliquant sur « S&apos;inscrire », tu acceptes nos conditions générales.
            </ThemedText>

            {error ? (
              <ThemedText type="small" style={{ color: Colors.dark.error }}>
                {error}
              </ThemedText>
            ) : null}

            <Button glass title="S'inscrire" onPress={onSubmit} loading={submitting} />

            <Link href="/login" style={styles.link}>
              <ThemedText type="link" style={{ color: accentColor }}>
                Déjà un compte ? Se connecter
              </ThemedText>
            </Link>
            </Animated.View>
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
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    gap: Spacing.three,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  intro: {
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  form: {
    gap: Spacing.three,
  },
  nameRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  birthdaySection: {
    gap: Spacing.two,
  },
  birthdayRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  genderSection: {
    gap: Spacing.two,
  },
  genderRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  genderOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.threeHalf,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radii.md,
  },
  genderSelectedText: {
    color: Colors.dark.onAccent,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  terms: {
    lineHeight: 18,
  },
  link: {
    alignSelf: 'center',
    marginTop: Spacing.one,
  },
});
