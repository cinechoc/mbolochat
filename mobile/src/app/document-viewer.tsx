/* eslint-disable react-hooks/refs, react-hooks/immutability -- callbacks de geste RNGH et valeurs Reanimated exécutés hors rendu */
import { Ionicons } from '@expo/vector-icons';
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TurboModuleRegistry,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PdfProps } from 'react-native-pdf';

import { useChatColors } from '@/constants/chat-theme';
import { Fonts, Spacing } from '@/constants/theme';
import {
  documentFileName,
  documentPreviewKind,
  documentTypeLabel,
  documentVisual,
  formatFileSize,
  middleTruncate,
} from '@/features/media/mediaLayout';
import { ImageViewer } from '@/features/media/MediaViewers';
import { ProgressRing } from '@/features/media/ProgressRing';

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const CACHE_DIRECTORY = 'mbolochat-documents';
const DEFAULT_TEXT_FONT_SIZE = 13;
const MIN_TEXT_FONT_SIZE = 10;
const MAX_TEXT_FONT_SIZE = 32;

/** Taille choisie pendant la session, partagée entre les documents texte. */
let sessionTextFontSize = DEFAULT_TEXT_FONT_SIZE;

type Status = 'loading' | 'ready' | 'error';

function stableCacheKey(url: string, name: string): string {
  const fileKey = /[?&]f=([^&]+)/.exec(url)?.[1] ?? url.split('?')[0] ?? url;
  const identity = `${name}|${fileKey}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

interface DownloadBytes {
  uploaded: number;
  total: number;
}

interface DownloadControl {
  cancel: () => void;
}

async function ensureLocalFile(
  url: string,
  name: string,
  mime: string,
  expectedSize: number,
  force: boolean,
  onProgress: (bytes: DownloadBytes) => void,
  signal: AbortSignal,
  onControl: (control: DownloadControl | null) => void,
): Promise<{ uri: string; size: number }> {
  if (/^(file|content):/i.test(url)) {
    const local = new File(url);
    if (!local.exists) {
      throw new Error('Le fichier local n’est plus disponible.');
    }
    return { uri: local.uri, size: local.size };
  }

  // Un sous-dossier par fichier : le nom partagé reste le nom d'origine.
  const root = new Directory(Paths.cache, CACHE_DIRECTORY);
  const directory = new Directory(root, stableCacheKey(url, name));
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, documentFileName(name, mime));

  if (destination.exists) {
    if (!force) {
      const size = destination.size;
      if (expectedSize > 0 ? size === expectedSize : size > 0) {
        return { uri: destination.uri, size };
      }
    }
    destination.delete();
  }

  const removePartial = () => {
    try {
      if (destination.exists) destination.delete();
    } catch {
      // Un cache partiel resté verrouillé sera retenté par l'annulation.
    }
  };

  let resumable: ReturnType<typeof createDownloadResumable> | null = null;
  try {
    resumable = createDownloadResumable(
      url,
      destination.uri,
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        onProgress({
          uploaded: totalBytesWritten,
          total: totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedSize,
        });
      },
    );
    onControl({
      cancel: () => {
        void resumable?.cancelAsync();
        // Android peut finir d'écrire le tampon natif après le cancelAsync().
        setTimeout(removePartial, 300);
        setTimeout(removePartial, 1500);
      },
    });
    const downloaded = await resumable.downloadAsync();
    if (
      !downloaded ||
      downloaded.status < 200 ||
      downloaded.status >= 300
    ) {
      throw new Error(
        downloaded ? `Téléchargement impossible (${downloaded.status})` : 'Téléchargement interrompu.',
      );
    }
    const size = new File(downloaded.uri).size || expectedSize;
    onProgress({ uploaded: size, total: size });
    return { uri: destination.uri, size };
  } catch (error) {
    removePartial();
    throw error;
  } finally {
    onControl(null);
  }
}

function downloadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  if (/UnableToDownload|status/i.test(raw)) {
    return 'Le document n’a pas pu être téléchargé depuis le serveur.';
  }
  if (/network|connect|timeout|fetch|internet/i.test(raw)) {
    return 'Le téléchargement a échoué. Vérifie ta connexion puis réessaie.';
  }
  return raw && raw.startsWith('Le fichier local')
    ? raw
    : 'Impossible d’ouvrir ce document.';
}

function pdfErrorMessage(error: Error & { status?: number }): string {
  const raw = error.message ?? '';
  if (/password|encrypt/i.test(raw)) {
    return 'Ce PDF est protégé par un mot de passe et ne peut pas être affiché.';
  }
  if (/not found|missing|no such file/i.test(raw)) {
    return 'Le fichier PDF est introuvable dans le cache.';
  }
  return 'Impossible d’afficher ce PDF. Il est peut-être endommagé.';
}

interface PdfPreviewProps {
  uri: string;
  onPage: (page: number, total: number) => void;
  onError: (message: string) => void;
  onUnavailable: (message: string) => void;
}

function PdfPreview({ uri, onPage, onError, onUnavailable }: PdfPreviewProps) {
  const [PdfComponent, setPdfComponent] = useState<ComponentType<PdfProps> | null>(null);

  useEffect(() => {
    // Le module natif est absent d'un build antérieur à l'installation : on
    // s'arrête avant d'évaluer react-native-pdf, qui lèverait une erreur.
    if (!TurboModuleRegistry.get('ReactNativeBlobUtil')) {
      onUnavailable(
        'Le lecteur PDF n’est pas disponible dans cette version de l’application. Recompilez le client de développement pour l’activer.',
      );
      return;
    }
    let active = true;
    Promise.resolve()
      .then(() => import('react-native-pdf'))
      .then((module) => {
        if (active) {
          const Pdf = module.default;
          setPdfComponent(() => Pdf);
        }
      })
      .catch(() => {
        if (active) {
          onUnavailable(
            'Le lecteur PDF n’est pas disponible dans cette version de l’application. Recompilez le client de développement pour l’activer.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [onUnavailable]);

  if (!PdfComponent) {
    return (
      <View style={styles.pdfLoading}>
        <ActivityIndicator color="#07C160" />
      </View>
    );
  }

  return (
    <PdfComponent
      source={{ uri }}
      style={styles.pdf}
      horizontal={false}
      enablePaging={false}
      scrollEnabled
      fitPolicy={0}
      spacing={8}
      minScale={1}
      maxScale={5}
      enableDoubleTapZoom
      trustAllCerts={false}
      renderActivityIndicator={() => <ActivityIndicator color="#07C160" />}
      onLoadComplete={(numberOfPages) => onPage(1, numberOfPages)}
      onPageChanged={(page, numberOfPages) => onPage(page, numberOfPages)}
      onError={(error) => onError(pdfErrorMessage(error))}
    />
  );
}

export default function DocumentViewerScreen() {
  const { url, name, mime, size } = useLocalSearchParams<{
    url: string;
    name: string;
    mime: string;
    size: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const chat = useChatColors();

  const [status, setStatus] = useState<Status>('loading');
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [localSize, setLocalSize] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [downloadBytes, setDownloadBytes] = useState<DownloadBytes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pdfUnavailable, setPdfUnavailable] = useState(false);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const downloadControlRef = useRef<DownloadControl | null>(null);

  const [fontSize, setFontSize] = useState(sessionTextFontSize);
  const pinchScale = useSharedValue(1);
  const gestureStartFont = useRef(fontSize);

  const commitFontSize = useCallback((value: number) => {
    const next = Math.max(
      MIN_TEXT_FONT_SIZE,
      Math.min(MAX_TEXT_FONT_SIZE, Math.round(value)),
    );
    sessionTextFontSize = next;
    setFontSize(next);
  }, []);

  const adjustFont = useCallback(
    (delta: number) => {
      commitFontSize(fontSize + delta);
    },
    [commitFontSize, fontSize],
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          gestureStartFont.current = fontSize;
          pinchScale.value = 1;
        })
        .onUpdate((event) => {
          const start = gestureStartFont.current;
          const min = MIN_TEXT_FONT_SIZE / start;
          const max = MAX_TEXT_FONT_SIZE / start;
          pinchScale.value = Math.min(max, Math.max(min, event.scale));
        })
        .onEnd((event) => {
          commitFontSize(gestureStartFont.current * event.scale);
          pinchScale.value = 1;
        })
        .onFinalize(() => {
          pinchScale.value = 1;
        }),
    [commitFontSize, fontSize, pinchScale],
  );

  const doubleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .runOnJS(true)
        .onEnd(() => {
          commitFontSize(
            fontSize === DEFAULT_TEXT_FONT_SIZE
              ? Math.round(DEFAULT_TEXT_FONT_SIZE * 1.6)
              : DEFAULT_TEXT_FONT_SIZE,
          );
        }),
    [commitFontSize, fontSize],
  );

  const textGestures = useMemo(
    () => Gesture.Simultaneous(pinchGesture, doubleTapGesture),
    [doubleTapGesture, pinchGesture],
  );
  const textScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pinchScale.value }],
  }));

  const expectedSize = Number(size) > 0 ? Number(size) : 0;
  const kind = documentPreviewKind(name ?? '', mime ?? '');
  const visual = documentVisual(name ?? '', mime ?? '');

  useEffect(() => {
    if (kind === 'image') {
      return;
    }
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    downloadControlRef.current = null;
    let active = true;
    let lastPercent: number | null | undefined;
    (async () => {
      try {
        const file = await ensureLocalFile(
          url,
          name,
          mime,
          expectedSize,
          attempt > 0,
          ({ uploaded, total }) => {
            if (!active) return;
            const denominator = total > 0 ? total : expectedSize;
            const percent =
              denominator > 0
                ? Math.max(0, Math.min(100, Math.round((uploaded / denominator) * 100)))
                : null;
            if (percent === lastPercent) return;
            lastPercent = percent;
            setDownloadBytes(
              denominator > 0
                ? { uploaded: Math.min(uploaded, denominator), total: denominator }
                : null,
            );
            setProgress(percent);
          },
          controller.signal,
          (control) => {
            downloadControlRef.current = control;
          },
        );
        if (!active) return;
        setLocalUri(file.uri);
        setLocalSize(file.size);
        if (kind === 'text') {
          if (file.size > TEXT_PREVIEW_LIMIT) {
            setTooLarge(true);
            setStatus('ready');
            setProgress(null);
            setDownloadBytes(null);
            return;
          }
          const content = await new File(file.uri).text();
          if (!active) return;
          setText(content);
        }
        setError(null);
        setProgress(null);
        setDownloadBytes(null);
        setStatus('ready');
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setError(downloadError(err));
        setProgress(null);
        setDownloadBytes(null);
        setStatus('error');
      }
    })();
    return () => {
      active = false;
      downloadControlRef.current?.cancel();
      controller.abort();
    };
  }, [url, name, mime, expectedSize, kind, attempt]);

  const openExternal = useCallback(async () => {
    if (!localUri) {
      return;
    }
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Le partage de fichiers n’est pas disponible sur cet appareil.');
      }
      await Sharing.shareAsync(localUri, { mimeType: mime, dialogTitle: name });
    } catch (err) {
      Alert.alert(
        'Ouverture impossible',
        err instanceof Error ? err.message : 'Impossible d’ouvrir ce document.',
      );
    }
  }, [localUri, mime, name]);

  const cancelDownload = useCallback(() => {
    downloadControlRef.current?.cancel();
    downloadAbortRef.current?.abort();
    router.back();
  }, [router]);

  const retry = useCallback(() => {
    setStatus('loading');
    setError(null);
    setTooLarge(false);
    setText(null);
    setProgress(null);
    setDownloadBytes(null);
    setPage(1);
    setPageCount(0);
    setPdfUnavailable(false);
    setAttempt((value) => value + 1);
  }, []);

  const handlePage = useCallback((current: number, total: number) => {
    setPage(current);
    setPageCount(total);
  }, []);

  const handlePdfError = useCallback((message: string) => {
    setError(message);
    setStatus('error');
  }, []);

  const handlePdfUnavailable = useCallback((message: string) => {
    setPdfUnavailable(true);
    setError(message);
    setStatus('error');
  }, []);

  if (kind === 'image') {
    return <ImageViewer urls={[url]} initialIndex={0} onClose={() => router.back()} />;
  }

  const header = (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 6,
          backgroundColor: chat.composer,
          borderBottomColor: chat.border,
        },
      ]}>
      <Pressable
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Retour à la conversation"
        style={styles.headerButton}>
        <Ionicons name="chevron-back" size={26} color={chat.primaryText} />
      </Pressable>
      <View style={styles.headerTitle}>
        <Text numberOfLines={1} style={[styles.fileName, { color: chat.primaryText }]}>
          {middleTruncate(name || 'Document', 42)}
        </Text>
        <Text style={[styles.fileMeta, { color: chat.secondaryText }]}>
          {formatFileSize(localSize ?? expectedSize)}
        </Text>
      </View>
      {kind === 'text' ? (
        <View style={styles.textSizeButtons}>
          <Pressable
            onPress={() => adjustFont(-2)}
            disabled={fontSize <= MIN_TEXT_FONT_SIZE}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Réduire la taille du texte"
            accessibilityState={{ disabled: fontSize <= MIN_TEXT_FONT_SIZE }}
            style={[styles.textSizeButton, fontSize <= MIN_TEXT_FONT_SIZE && styles.disabled]}>
            <Text style={[styles.textSizeLabel, { color: chat.primaryText }]}>A−</Text>
          </Pressable>
          <Pressable
            onPress={() => adjustFont(2)}
            disabled={fontSize >= MAX_TEXT_FONT_SIZE}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Agrandir la taille du texte"
            accessibilityState={{ disabled: fontSize >= MAX_TEXT_FONT_SIZE }}
            style={[styles.textSizeButton, fontSize >= MAX_TEXT_FONT_SIZE && styles.disabled]}>
            <Text style={[styles.textSizeLabel, { color: chat.primaryText }]}>A+</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={() => void openExternal()}
        disabled={!localUri}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Ouvrir avec une autre application"
        accessibilityState={{ disabled: !localUri }}
        style={[styles.headerButton, !localUri && styles.disabled]}>
        <Ionicons
          name="open-outline"
          size={22}
          color={localUri ? chat.send : chat.secondaryText}
        />
      </Pressable>
    </View>
  );

  const cancelable = status === 'loading' && /^https?:/i.test(url ?? '');
  let body: ReactNode;
  if (status === 'loading') {
    body = (
      <View style={styles.downloadScreen}>
        <ProgressRing
          progress={progress === null ? undefined : progress / 100}
          size={96}
          strokeWidth={5}
          color={chat.send}
          trackColor={chat.border}>
          <Text style={[styles.downloadPercent, { color: chat.primaryText }]}>
            {progress !== null ? `${progress} %` : ''}
          </Text>
        </ProgressRing>
        <Text numberOfLines={1} style={[styles.downloadName, { color: chat.primaryText }]}>
          {middleTruncate(name || 'Document', 36)}
        </Text>
        <Text style={[styles.downloadBytes, { color: chat.secondaryText }]}>
          {downloadBytes
            ? `${formatFileSize(downloadBytes.uploaded)} sur ${formatFileSize(downloadBytes.total)}`
            : cancelable
              ? 'Téléchargement…'
              : 'Ouverture du document…'}
        </Text>
        {cancelable ? (
          <Pressable
            onPress={cancelDownload}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Annuler le téléchargement"
            style={styles.cancelButton}>
            <Text style={[styles.cancelText, { color: chat.secondaryText }]}>Annuler</Text>
          </Pressable>
        ) : null}
      </View>
    );
  } else if (status === 'error') {
    body = (
      <View style={styles.center}>
        <View style={[styles.card, { backgroundColor: chat.theirBubble }]}>
          <Ionicons name="alert-circle-outline" size={48} color={chat.error} />
          <Text style={[styles.cardTitle, { color: chat.primaryText }]}>
            {pdfUnavailable ? 'Lecteur indisponible' : 'Document indisponible'}
          </Text>
          <Text style={[styles.cardBody, { color: chat.secondaryText }]}>{error}</Text>
          <View style={styles.buttons}>
            {!pdfUnavailable ? (
              <Pressable
                onPress={retry}
                accessibilityRole="button"
                accessibilityLabel="Réessayer de télécharger le document"
                style={[styles.primaryButton, { backgroundColor: chat.send }]}>
                <Ionicons name="refresh" size={18} color={chat.sendText} />
                <Text style={[styles.primaryText, { color: chat.sendText }]}>Réessayer</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => void openExternal()}
              disabled={!localUri}
              accessibilityRole="button"
              accessibilityLabel="Ouvrir avec une autre application"
              accessibilityState={{ disabled: !localUri }}
              style={[
                styles.secondaryButton,
                { borderColor: chat.border },
                !localUri && styles.disabled,
              ]}>
              <Ionicons name="open-outline" size={18} color={chat.primaryText} />
              <Text style={[styles.secondaryText, { color: chat.primaryText }]}>
                Ouvrir avec une autre application
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  } else if (kind === 'text' && tooLarge) {
    body = (
      <View style={styles.center}>
        <View style={[styles.card, { backgroundColor: chat.theirBubble }]}>
          <Ionicons name="document-text-outline" size={48} color={visual.color} />
          <Text style={[styles.cardTitle, { color: chat.primaryText }]}>
            Fichier trop volumineux pour l’aperçu
          </Text>
          <Text style={[styles.cardBody, { color: chat.secondaryText }]}>
            L’aperçu intégré est limité à 2 Mo. Le fichier reste disponible pour une
            ouverture externe.
          </Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={() => void openExternal()}
              accessibilityRole="button"
              accessibilityLabel="Ouvrir avec une autre application"
              style={[styles.primaryButton, { backgroundColor: chat.send }]}>
              <Ionicons name="open-outline" size={18} color={chat.sendText} />
              <Text style={[styles.primaryText, { color: chat.sendText }]}>
                Ouvrir avec une autre application
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  } else if (kind === 'text') {
    body = (
      <GestureDetector gesture={textGestures}>
        <ScrollView style={styles.reader} contentContainerStyle={styles.readerContent}>
          <Animated.View
            style={[
              styles.textCard,
              { backgroundColor: chat.theirBubble },
              textScaleStyle,
            ]}>
            <Text
              selectable
              style={[
                styles.textContent,
                {
                  color: chat.primaryText,
                  fontSize,
                  lineHeight: Math.round(fontSize * 1.45),
                },
              ]}>
              {text ?? ''}
            </Text>
          </Animated.View>
        </ScrollView>
      </GestureDetector>
    );
  } else if (kind === 'pdf') {
    body = (
      <View style={styles.pdfContainer}>
        <PdfPreview
          key={attempt}
          uri={localUri ?? ''}
          onPage={handlePage}
          onError={handlePdfError}
          onUnavailable={handlePdfUnavailable}
        />
        {pageCount > 0 ? (
          <View style={[styles.pagePill, { bottom: insets.bottom + 16 }]}>
            <Text style={styles.pageText}>
              {page} / {pageCount}
            </Text>
          </View>
        ) : null}
      </View>
    );
  } else {
    body = (
      <View style={styles.center}>
        <View style={[styles.card, { backgroundColor: chat.theirBubble }]}>
          <View style={[styles.infoIcon, { backgroundColor: `${visual.color}1A` }]}>
            <Ionicons name={visual.icon} size={44} color={visual.color} />
          </View>
          <Text style={[styles.cardTitle, { color: chat.primaryText }]}>
            {middleTruncate(name || 'Document', 48)}
          </Text>
          <Text style={[styles.cardBody, { color: chat.secondaryText }]}>
            {documentTypeLabel(name ?? '', mime ?? '')} · {formatFileSize(localSize ?? expectedSize)}
          </Text>
          <Text style={[styles.cardBody, { color: chat.secondaryText }]}>
            Ce format ne peut pas être affiché dans l’application. Ouvre-le avec une
            application compatible.
          </Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={() => void openExternal()}
              accessibilityRole="button"
              accessibilityLabel="Ouvrir avec une autre application"
              style={[styles.primaryButton, { backgroundColor: chat.send }]}>
              <Ionicons name="open-outline" size={18} color={chat.sendText} />
              <Text style={[styles.primaryText, { color: chat.sendText }]}>
                Ouvrir avec une autre application
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: chat.screen }]}>
      <Stack.Screen
        options={{
          headerShown: false,
          title: name || 'Document',
          animation: 'slide_from_right',
          // Le glissement de retour volerait les gestes horizontaux du PDF zoomé.
          gestureEnabled: false,
        }}
      />
      {header}
      {status === 'ready' ? (
        <Animated.View entering={FadeIn.duration(200)} style={styles.bodyFill}>
          {body}
        </Animated.View>
      ) : (
        body
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  bodyFill: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.one,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textSizeButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  textSizeButton: {
    width: 30,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textSizeLabel: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '600',
  },
  fileMeta: {
    fontSize: 11,
    lineHeight: 14,
    marginTop: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.two,
  },
  downloadScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.two,
  },
  downloadPercent: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  downloadName: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    maxWidth: '80%',
    textAlign: 'center',
  },
  downloadBytes: {
    fontSize: 12,
    lineHeight: 16,
  },
  cancelButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginTop: Spacing.two,
  },
  cancelText: {
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 10,
    padding: Spacing.four,
    alignItems: 'center',
    gap: Spacing.two,
  },
  cardTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  infoIcon: {
    width: 76,
    height: 76,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttons: {
    width: '100%',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  primaryButton: {
    minHeight: 46,
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  primaryText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  secondaryText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
  },
  disabled: {
    opacity: 0.45,
  },
  reader: {
    flex: 1,
  },
  readerContent: {
    padding: Spacing.two,
    paddingBottom: Spacing.five,
  },
  textCard: {
    borderRadius: 8,
    padding: Spacing.three,
  },
  textContent: {
    fontFamily: Fonts.mono,
  },
  pdfContainer: {
    flex: 1,
  },
  pdf: {
    flex: 1,
    width: '100%',
  },
  pdfLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagePill: {
    position: 'absolute',
    alignSelf: 'center',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  pageText: {
    color: '#ffffff',
    fontSize: 12,
    lineHeight: 16,
    fontVariant: ['tabular-nums'],
  },
});
