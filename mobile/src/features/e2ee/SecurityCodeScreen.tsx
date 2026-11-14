import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, ScanLine, ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CallSurface, Fonts, QrSurface, Radii, Scrim, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  loadE2eeAccount,
  loadIdentityVerification,
  loadSession,
  markIdentityVerified,
  openE2eeDatabase,
  type IdentityVerificationRow,
} from './db';
import {
  computeSafetyNumber,
  formatSafetyNumber,
  normalizeScannedSafetyNumber,
  safetyNumberQrPayload,
} from './safetyNumber';

/**
 * Écran de vérification d'identité. Il ne lit que les clés publiques par les
 * accesseurs existants et n'écrit que l'état local de vérification.
 */
export function SecurityCodeScreen() {
  const { peerId, conversationId } = useLocalSearchParams<{
    peerId?: string;
    conversationId?: string;
  }>();
  const { token } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState<string | null>(null);
  const [peerIdentityKey, setPeerIdentityKey] = useState<string | null>(null);
  const [verification, setVerification] = useState<IdentityVerificationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !peerId) return;
    let cancelled = false;
    void (async () => {
      let database: Awaited<ReturnType<typeof openE2eeDatabase>> | null = null;
      try {
        database = await openE2eeDatabase();
        const local = await loadE2eeAccount(database.db);
        if (!local) throw new Error('missing_account');
        const session = await loadSession(database.db, peerId);
        const peerKey =
          session?.peer_identity_key ??
          (await api.getE2eeKeyBundle(token, peerId, false)).identityKey;
        const nextCode = computeSafetyNumber(local.identity_key, peerKey);
        const state = await loadIdentityVerification(database.db, peerId);
        if (!cancelled) {
          setPeerIdentityKey(peerKey);
          setCode(nextCode);
          setVerification(state);
          setError(null);
        }
      } catch {
        if (!cancelled) setError(fr.e2eeChat.security.unavailable);
      } finally {
        await database?.db.closeAsync().catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peerId, token]);

  const markVerified = useCallback(async () => {
    if (!peerId || !peerIdentityKey || !code) return;
    let database: Awaited<ReturnType<typeof openE2eeDatabase>> | null = null;
    try {
      database = await openE2eeDatabase();
      await markIdentityVerified(database.db, peerId, peerIdentityKey, code);
      setVerification(await loadIdentityVerification(database.db, peerId));
    } catch {
      Alert.alert(fr.e2eeChat.security.title, fr.e2eeChat.security.unavailable);
    } finally {
      await database?.db.closeAsync().catch(() => undefined);
    }
  }, [code, peerId, peerIdentityKey]);

  const openScanner = useCallback(async () => {
    if (!permission?.granted) {
      const granted = await requestPermission();
      if (!granted.granted) {
        Alert.alert(fr.e2eeChat.security.scanTitle, fr.e2eeChat.security.cameraDenied);
        return;
      }
    }
    setScanResult(null);
    setScanning(true);
  }, [permission?.granted, requestPermission]);

  const keyChanged = Boolean(
    verification &&
      peerIdentityKey &&
      verification.peer_identity_key !== peerIdentityKey,
  );
  const verified = Boolean(
    verification?.verified_at && verification.peer_identity_key === peerIdentityKey && !keyChanged,
  );
  const visibleCode = code ? formatSafetyNumber(code) : '';

  return (
    <ThemedView style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={fr.common.close}
          onPress={() => router.back()}
          hitSlop={8}>
          <ThemedText type="small" themeColor="accent">
            {fr.common.close}
          </ThemedText>
        </Pressable>
        <ThemedText type="sectionTitle">{fr.e2eeChat.security.title}</ThemedText>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="small" themeColor="textSecondary">
          {fr.e2eeChat.security.intro}
        </ThemedText>
        {error ? (
          <ThemedText type="small" themeColor="error">
            {error}
          </ThemedText>
        ) : null}
        {!code && !error ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.e2eeChat.security.loading}
          </ThemedText>
        ) : null}
        {keyChanged ? (
          <View style={[styles.banner, { backgroundColor: theme.accentSoft, borderColor: theme.border }]}>
            <ThemedText type="small">{fr.e2eeChat.security.keyChangedTitle}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {fr.e2eeChat.security.keyChangedBody}
            </ThemedText>
          </View>
        ) : null}
        {code ? (
          <>
            <View style={[styles.qrCard, { backgroundColor: QrSurface }]}>
              <QRCode value={safetyNumberQrPayload(code)} size={220} />
            </View>
            <ThemedText selectable style={[styles.code, { color: theme.text }]}>
              {visibleCode}
            </ThemedText>
            <View style={styles.status}>
              <ShieldCheck size={18} color={verified ? theme.accent : theme.textSecondary} />
              <ThemedText
                type="small"
                style={{ color: verified ? theme.accent : theme.textSecondary }}>
                {verified ? fr.e2eeChat.security.verified : fr.e2eeChat.security.notVerified}
              </ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => void markVerified()}
              style={[styles.primary, { backgroundColor: theme.accent }]}>
              <Check size={18} color={theme.onAccent} />
              <ThemedText style={{ color: theme.onAccent }}>
                {fr.e2eeChat.security.markVerified}
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void openScanner()}
              style={[styles.secondary, { borderColor: theme.border }]}>
              <ScanLine size={18} color={theme.accent} />
              <ThemedText type="small" themeColor="accent">
                {fr.e2eeChat.security.scan}
              </ThemedText>
            </Pressable>
            {scanResult ? (
              <ThemedText
                type="small"
                style={{ color: scanResult === code ? theme.accent : theme.danger }}>
                {scanResult === code
                  ? fr.e2eeChat.security.scannedMatch
                  : fr.e2eeChat.security.scannedMismatch}
              </ThemedText>
            ) : null}
          </>
        ) : null}
        {conversationId ? (
          <ThemedText type="micro" themeColor="textSecondary">
            {conversationId}
          </ThemedText>
        ) : null}
      </ScrollView>
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.scanner}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              const scanned = normalizeScannedSafetyNumber(data);
              if (!scanned) return;
              setScanResult(scanned);
              setScanning(false);
            }}
          />
          <View style={styles.scanOverlay}>
            <ThemedText style={styles.scanText}>{fr.e2eeChat.security.scanHint}</ThemedText>
            <Pressable
              accessibilityRole="button"
              onPress={() => setScanning(false)}
              style={[styles.scanClose, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small">{fr.e2eeChat.security.closeScanner}</ThemedText>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingTop: 52,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerSpacer: { width: 48 },
  content: { padding: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.five },
  qrCard: {
    alignSelf: 'center',
    padding: Spacing.three,
    borderRadius: Radii.lg,
  },
  code: {
    textAlign: 'center',
    fontFamily: Fonts.mono,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 1,
  },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  banner: { borderWidth: 1, borderRadius: Radii.md, padding: Spacing.three, gap: Spacing.one },
  primary: {
    minHeight: 44,
    borderRadius: Radii.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  secondary: {
    minHeight: 44,
    borderRadius: Radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  scanner: { flex: 1, backgroundColor: Scrim },
  scanOverlay: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: 64,
    alignItems: 'center',
    gap: Spacing.three,
  },
  scanText: { color: CallSurface.onSurface, textAlign: 'center' },
  scanClose: { minHeight: 44, borderRadius: Radii.md, paddingHorizontal: Spacing.three, justifyContent: 'center' },
});
