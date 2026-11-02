import { File, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';

import { openE2eeDatabase } from '@/features/e2ee/db';
import { bootstrapE2ee, type BootstrapResult } from '@/features/e2ee/bootstrap';
import { sweepSecureMedia } from '@/features/e2ee/mediaStore';
import { useAuth } from '@/lib/auth-context';
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
  const { token } = useAuth();
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [storage, setStorage] = useState<{ recovered: boolean; version: string; encryptedHeader: boolean } | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageRunning, setStorageRunning] = useState(false);
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [bootstrapRunning, setBootstrapRunning] = useState(false);
  const [keyLoss, setKeyLoss] = useState<{ simulated: boolean; recovered: boolean } | null>(null);
  const [keyLossRunning, setKeyLossRunning] = useState(false);

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

  const runStorage = async () => {
    if (storageRunning) return;
    setStorageRunning(true);
    setStorageError(null);
    setStorage(null);
    try {
      const opened = await openE2eeDatabase();
      const rawPath = opened.db.databasePath;
      const directory = String(defaultDatabaseDirectory).replace(/\/+$/, '');
      const path = rawPath.startsWith('file://')
        ? rawPath
        : rawPath.startsWith('/')
          ? `file://${rawPath}`
          : `${directory}/${rawPath.split('/').pop()}`;
      await opened.db.closeAsync();
      const bytes = await new File(path).bytes();
      const header = String.fromCharCode(...Array.from(bytes.slice(0, 15)));
      setStorage({
        recovered: opened.recovered,
        version: opened.cipherVersion,
        encryptedHeader: !header.startsWith('SQLite format 3'),
      });
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : fr.e2eeDev.storageError);
    } finally {
      setStorageRunning(false);
    }
  };

  const runBootstrap = async () => {
    if (!token || bootstrapRunning) return;
    setBootstrapRunning(true);
    setBootstrap(null);
    try {
      setBootstrap(await bootstrapE2ee(token));
    } finally {
      setBootstrapRunning(false);
    }
  };

  const runKeyLoss = async () => {
    if (keyLossRunning) return;
    setKeyLossRunning(true);
    setKeyLoss(null);
    try {
      const simulated = await MboloCrypto.simulateKeyLoss();
      const ensured = await MboloCrypto.ensureKeys();
      // Identité perdue : les clés des médias temporaires le sont aussi, rien ne
      // doit rester déchiffrable sur le disque.
      sweepSecureMedia();
      setKeyLoss({ simulated: simulated.simulated, recovered: ensured.recovered });
    } finally {
      setKeyLossRunning(false);
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

        <Pressable
          onPress={() => void runStorage()}
          disabled={storageRunning}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: theme.backgroundElement,
              opacity: storageRunning ? 0.6 : pressed ? 0.85 : 1,
            },
          ]}>
          <ThemedText style={styles.storageLabel}>
            {storageRunning ? fr.e2eeDev.storageRunning : fr.e2eeDev.storageRun}
          </ThemedText>
        </Pressable>
        {storage ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeDev.storageResult(storage.recovered, storage.version, storage.encryptedHeader)}
          </ThemedText>
        ) : null}
        {storageError ? (
          <ThemedText type="small" style={styles.error}>
            {fr.e2eeDev.storageError}: {storageError}
          </ThemedText>
        ) : null}

        <Pressable
          onPress={() => void runBootstrap()}
          disabled={!token || bootstrapRunning}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: theme.backgroundElement,
              opacity: !token || bootstrapRunning ? 0.5 : pressed ? 0.85 : 1,
            },
          ]}>
          <ThemedText style={styles.storageLabel}>
            {bootstrapRunning ? fr.e2eeDev.bootstrapRunning : fr.e2eeDev.bootstrapRun}
          </ThemedText>
        </Pressable>
        {!token ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeDev.bootstrapNeedLogin}
          </ThemedText>
        ) : null}
        {bootstrap ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeDev.bootstrapResult(
              bootstrap.registered,
              bootstrap.recovered,
              bootstrap.error ?? '',
            )}
          </ThemedText>
        ) : null}

        <Pressable
          onPress={() => void runKeyLoss()}
          disabled={keyLossRunning}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: theme.backgroundElement,
              opacity: keyLossRunning ? 0.6 : pressed ? 0.85 : 1,
            },
          ]}>
          <ThemedText style={styles.storageLabel}>
            {keyLossRunning ? fr.e2eeDev.keyLossRunning : fr.e2eeDev.keyLossRun}
          </ThemedText>
        </Pressable>
        {keyLoss ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeDev.keyLossResult(keyLoss.simulated, keyLoss.recovered)}
          </ThemedText>
        ) : null}

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
  storageLabel: { fontWeight: '700', fontSize: 16 },
  panel: { borderRadius: Radii.md, padding: Spacing.three, gap: Spacing.two },
  step: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  stepLabel: { flex: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#8e8e93' },
  error: { color: '#e5484d' },
});
