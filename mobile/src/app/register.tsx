import { Link, Redirect, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { LogoMark } from '@/components/logo';
import { Select, type SelectOption } from '@/components/select';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, PasswordField, TextField, accentColor } from '@/components/ui';
import { Spacing, Radii } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useTheme } from '@/hooks/use-theme';
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
  const theme = useTheme();
  const router = useRouter();
  const keyboardHeight = useKeyboardHeight();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [year, setYear] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender | null>(null);
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
      style={[
        styles.container,
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
      ]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <SafeAreaView style={styles.flex} edges={['top', 'left', 'right']}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Animated.View entering={FadeInUp.duration(520)} style={styles.brandBlock}>
              <ThemedView style={styles.brandRow}>
                <LogoMark size={40} />
                <ThemedText type="subtitle" style={{ color: accentColor }}>
                  MboloChat
                </ThemedText>
              </ThemedView>
              <ThemedText type="small" themeColor="textSecondary">
                Créer un compte — c&apos;est rapide et facile.
              </ThemedText>
            </Animated.View>

            <Animated.View entering={FadeInUp.duration(520).delay(120)} style={styles.form}>
            <ThemedView style={styles.nameRow}>
              <TextField
                style={styles.flex}
                placeholder="Prénom"
                autoCapitalize="words"
                value={firstName}
                onChangeText={setFirstName}
              />
              <TextField
                style={styles.flex}
                placeholder="Nom de famille"
                autoCapitalize="words"
                value={lastName}
                onChangeText={setLastName}
              />
            </ThemedView>

            <TextField
              placeholder="Adresse e-mail"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <PasswordField
              placeholder="Nouveau mot de passe"
              value={password}
              onChangeText={setPassword}
            />

            <ThemedView style={styles.birthdaySection}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                Date de naissance
              </ThemedText>
              <ThemedView style={styles.birthdayRow}>
                <Select
                  style={styles.flex}
                  placeholder="Jour"
                  options={dayOptions}
                  value={day}
                  onChange={setDay}
                />
                <Select
                  style={styles.flex}
                  placeholder="Mois"
                  options={monthOptions}
                  value={month}
                  onChange={setMonth}
                />
                <Select
                  style={styles.flex}
                  placeholder="Année"
                  options={yearOptions}
                  value={year}
                  onChange={setYear}
                />
              </ThemedView>
            </ThemedView>

            <ThemedView style={styles.genderSection}>
              <ThemedText type="smallBold" themeColor="textSecondary">
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
                        { backgroundColor: selected ? accentColor : theme.backgroundElement },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText
                        type="small"
                        style={selected ? styles.genderSelectedText : undefined}>
                        {option.label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </ThemedView>
            </ThemedView>

            <ThemedText type="small" themeColor="textSecondary" style={styles.terms}>
              En cliquant sur « S&apos;inscrire », tu acceptes nos conditions générales.
            </ThemedText>

            {error ? (
              <ThemedText type="small" style={{ color: theme.error }}>
                {error}
              </ThemedText>
            ) : null}

            <Button title="S'inscrire" onPress={onSubmit} loading={submitting} />

            <Link href="/login" style={styles.link}>
              <ThemedText type="link" style={{ color: accentColor }}>
                Déjà un compte ? Se connecter
              </ThemedText>
            </Link>
            </Animated.View>
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
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    gap: Spacing.three,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  brandBlock: {
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
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
    paddingVertical: 12,
    borderRadius: Radii.md,
  },
  genderSelectedText: {
    color: '#ffffff',
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
