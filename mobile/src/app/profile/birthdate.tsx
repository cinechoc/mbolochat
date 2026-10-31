import { Redirect, Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceSheet, type ChoiceOption } from '@/components/choice-sheet';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

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

type Picker = 'day' | 'month' | 'year' | null;

/** Date de naissance d'un compte ancien : une seule saisie, définitive. */
export default function BirthdateScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [day, setDay] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [saving, setSaving] = useState(false);

  const options = useMemo<ChoiceOption<string>[]>(() => {
    const currentYear = new Date().getUTCFullYear();
    if (picker === 'day') {
      return Array.from({ length: 31 }, (_, index) => ({
        value: String(index + 1),
        label: String(index + 1),
      }));
    }
    if (picker === 'month') {
      return MONTHS.map((label, index) => ({ value: String(index + 1), label }));
    }
    if (picker === 'year') {
      return Array.from({ length: 108 }, (_, index) => currentYear - 13 - index).map(
        (value) => ({ value: String(value), label: String(value) }),
      );
    }
    return [];
  }, [picker]);

  if (!token) {
    return <Redirect href="/login" />;
  }

  const selectedValue =
    picker === 'day' ? String(day ?? '') : picker === 'month' ? String(month ?? '') : String(year ?? '');

  const submit = async () => {
    if (!token || saving || !day || !month || !year) {
      return;
    }
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
      Alert.alert('Date invalide', 'Cette date n’existe pas dans le calendrier.');
      return;
    }
    setSaving(true);
    try {
      await api.setBirthdate(
        token,
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      );
      Alert.alert('Date enregistrée', 'Votre âge sera calculé à partir de cette date.', [
        { text: 'Fermer', onPress: () => router.back() },
      ]);
    } catch (cause) {
      Alert.alert(
        'Enregistrement impossible',
        cause instanceof ApiError ? cause.message : 'Réessayez plus tard.',
      );
    } finally {
      setSaving(false);
    }
  };

  const card = (label: string, value: string, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
      ]}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText style={styles.value}>{value}</ThemedText>
    </Pressable>
  );

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.profile.birthdateTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <ThemedText type="body" themeColor="textSecondary">
          {fr.profile.birthdateBody}
        </ThemedText>
        <View style={styles.row}>
          {card('Jour', day ? String(day) : '—', () => setPicker('day'))}
          {card('Mois', month ? MONTHS[month - 1] : '—', () => setPicker('month'))}
          {card('Année', year ? String(year) : '—', () => setPicker('year'))}
        </View>
        <Pressable
          onPress={() => void submit()}
          disabled={!day || !month || !year || saving}
          style={({ pressed }) => [
            styles.submit,
            {
              backgroundColor: theme.accent,
              opacity: !day || !month || !year || saving ? 0.5 : pressed ? 0.85 : 1,
            },
          ]}>
          <ThemedText style={styles.submitLabel}>
            {saving ? 'Enregistrement…' : fr.profile.birthdateOnce}
          </ThemedText>
        </Pressable>
      </ScrollView>

      <ChoiceSheet
        visible={picker !== null}
        title={
          picker === 'day' ? 'Jour' : picker === 'month' ? 'Mois' : 'Année'
        }
        options={options}
        value={selectedValue}
        onSelect={(value) => {
          if (picker === 'day') setDay(Number(value));
          else if (picker === 'month') setMonth(Number(value));
          else setYear(Number(value));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.three },
  row: { flexDirection: 'row', gap: Spacing.two },
  card: {
    flex: 1,
    minHeight: 64,
    borderRadius: Radii.md,
    padding: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  value: { fontSize: 17, fontWeight: '600' },
  submit: {
    minHeight: 48,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  submitLabel: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
});
