import { Globe2, Link2 } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import {
  fallbackLinkPreview,
  firstHttpUrl,
  mergeLinkPreview,
  parseHtmlLinkPreview,
  type LinkPreview,
} from '../model/link-preview';

const cache = new Map<string, LinkPreview>();
const pending = new Map<string, Promise<LinkPreview>>();
const FETCH_TIMEOUT_MS = 4_500;
const MAX_HTML_CHARS = 1_000_000;

async function loadPreview(url: string, base: LinkPreview): Promise<LinkPreview> {
  const existing = cache.get(url);
  if (existing) return existing;
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.toLowerCase().includes('html')) return base;
      const html = (await response.text()).slice(0, MAX_HTML_CHARS);
      const patch = parseHtmlLinkPreview(html, url);
      const preview = patch ? mergeLinkPreview(base, patch) : base;
      cache.set(url, preview);
      return preview;
    } catch {
      return base;
    } finally {
      clearTimeout(timer);
      pending.delete(url);
    }
  })();

  pending.set(url, promise);
  return promise;
}

/** Aperçu déjà chargé, ou repli immédiat sans nouvelle requête réseau. */
export function linkPreviewForSend(rawUrl: string): LinkPreview | null {
  const base = fallbackLinkPreview(rawUrl);
  if (!base) return null;
  return cache.get(base.url) ?? base;
}

/** Attend les métadonnées distantes, pour un envoi explicite hors du rendu. */
export async function resolveLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  const base = fallbackLinkPreview(rawUrl);
  if (!base) return null;
  return loadPreview(base.url, base);
}

export function LinkPreviewCard({
  url,
  preview: provided,
  compact = false,
}: {
  url?: string;
  preview?: LinkPreview | null;
  compact?: boolean;
}) {
  const preview = provided ?? null;
  const key = preview ? `${preview.url}:${preview.title}` : (url ?? '');
  return <LinkPreviewCardInner key={key} url={url} provided={preview} compact={compact} />;
}

function LinkPreviewCardInner({
  url,
  provided,
  compact,
}: {
  url?: string;
  provided: LinkPreview | null;
  compact: boolean;
}) {
  const theme = useTheme();
  const base = useMemo(
    () => provided ?? (url ? fallbackLinkPreview(url) : null),
    [provided, url],
  );
  const [preview, setPreview] = useState<LinkPreview | null>(base);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (!base || provided) return;
    let active = true;
    void loadPreview(base.url, base).then((next) => {
      if (active) setPreview(next);
    });
    return () => {
      active = false;
    };
  }, [base, provided]);

  if (!preview) return null;

  return (
    <Pressable
      onPress={() => void Linking.openURL(preview.url).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel={fr.chat.linkPreview.open(preview.title)}
      style={({ pressed }) => [
        styles.card,
        compact ? styles.cardCompact : null,
        {
          backgroundColor: theme.backgroundElement,
          borderColor: theme.border,
          borderLeftColor: theme.accent,
        },
        pressed && { opacity: 0.78 },
      ]}>
      {preview.imageUrl && !imageFailed ? (
        <Image
          source={{ uri: preview.imageUrl }}
          style={compact ? styles.thumbCompact : styles.thumb}
          resizeMode="cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <View
          style={[
            compact ? styles.thumbCompact : styles.thumb,
            styles.thumbFallback,
            { backgroundColor: theme.accentSoft },
          ]}>
          {compact ? (
            <Link2 size={18} strokeWidth={2.2} color={theme.accent} />
          ) : (
            <Globe2 size={22} strokeWidth={2.1} color={theme.accent} />
          )}
        </View>
      )}
      <View style={styles.copy}>
        <ThemedText
          type="smallBold"
          numberOfLines={compact ? 1 : 2}
          style={{ color: theme.text }}>
          {preview.title}
        </ThemedText>
        {!compact ? (
          <ThemedText
            type="micro"
            numberOfLines={2}
            style={{ color: theme.textSecondary }}>
            {preview.description}
          </ThemedText>
        ) : null}
        <ThemedText type="micro" numberOfLines={1} style={{ color: theme.accent }}>
          {preview.host}
        </ThemedText>
      </View>
    </Pressable>
  );
}

function LinkPreviewInText({
  text,
  preview,
}: {
  text: string;
  preview?: Omit<LinkPreview, 'imageUrl'> & { imageUrl?: string | null } | null;
}) {
  const url = useMemo(() => firstHttpUrl(text), [text]);
  if (preview) return <LinkPreviewCard preview={{ ...preview, imageUrl: preview.imageUrl ?? null }} />;
  return url ? <LinkPreviewCard url={url} /> : null;
}

export { LinkPreviewInText };

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: Spacing.two,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderRadius: Radii.sm,
    padding: Spacing.two,
  },
  cardCompact: { alignItems: 'center', paddingVertical: Spacing.one },
  thumb: { width: 54, height: 54, borderRadius: Radii.xs },
  thumbCompact: { width: 36, height: 36, borderRadius: Radii.xs },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: Spacing.half, justifyContent: 'center' },
});
