import { Paths } from 'expo-file-system';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { MboloCrypto, type SelfTestReport } from '../../../modules/mbolo-crypto/src';

const TEST_FILE_MB = 50;

function fileSystemPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/** Écran de développement : données de test uniquement, aucun secret affiché. */
export function E2eeSpikeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (running) {
      return;
    }
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      setReport(await MboloCrypto.selfTest(fileSystemPath(Paths.cache.uri), TEST_FILE_MB));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fr.e2eeDev.error);
    } finally {
      setRunning(false);
    }
  };

  const totalMs = report?.steps.reduce((sum, step) => sum + step.ms, 0) ?? 0;

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <ThemedText type="sectionTitle">{fr.e2eeDev.title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {fr.e2eeDev.intro}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {fr.e2eeDev.fileInfo(TEST_FILE_MB)}
        </ThemedText>

        <Pressable
          onPress={() => void run()}
          disabled={running}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: theme.accent,
              opacity: running ? 0.6 : pressed ? 0.85 : 1,
            },
          ]}>
          <ThemedText style={styles.buttonLabel}>
            {running ? fr.e2eeDev.running : fr.e2eeDev.run}
          </ThemedText>
        </Pressable>

        {report ? (
          <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
            {report.steps.map((step) => (
              <View key={step.key} style={styles.step}>
                <ThemedText style={styles.stepLabel}>
                  {fr.e2eeDev.steps[step.key as keyof typeof fr.e2eeDev.steps] ?? step.key}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {fr.e2eeDev.stepValue(step.ms)}
                </ThemedText>
              </View>
            ))}
            <View style={styles.separator} />
            <View style={styles.step}>
              <ThemedText type="smallBold">{fr.e2eeDev.total}</ThemedText>
              <ThemedText type="smallBold">{fr.e2eeDev.stepValue(totalMs)}</ThemedText>
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              {fr.e2eeDev.sizes(
                formatMegabytes(report.plaintext_size),
                formatMegabytes(report.ciphertext_size),
              )}
            </ThemedText>
          </View>
        ) : null}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {fr.e2eeDev.error}: {error}
          </ThemedText>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two },
  button: {
    minHeight: 48,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  buttonLabel: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
  panel: { borderRadius: Radii.md, padding: Spacing.three, gap: Spacing.two },
  step: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  stepLabel: { flex: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#8e8e93' },
  error: { color: '#e5484d' },
});
