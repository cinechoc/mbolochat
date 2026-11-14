export interface LinkPreview {
  url: string;
  host: string;
  title: string;
  description: string;
  imageUrl: string | null;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/i;
const TITLE_MAX = 90;
const DESCRIPTION_MAX = 180;

function cleanTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/u, '');
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Première URL http/https d’un message, ponctuation finale exclue. */
export function firstHttpUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  const candidate = cleanTrailingPunctuation(match[0]);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function titleFromUrl(url: URL): string {
  const part = url.pathname.split('/').filter(Boolean).pop();
  if (!part) return url.hostname.replace(/^www\./i, '');
  try {
    return truncate(decodeURIComponent(part).replace(/[-_]+/g, ' '), TITLE_MAX);
  } catch {
    return truncate(part.replace(/[-_]+/g, ' '), TITLE_MAX);
  }
}

/** Carte immédiatement disponible, remplacée ensuite par les métadonnées distantes. */
export function fallbackLinkPreview(rawUrl: string): LinkPreview | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      url: url.toString(),
      host: url.hostname.replace(/^www\./i, ''),
      title: titleFromUrl(url),
      description: url.hostname.replace(/^www\./i, ''),
      imageUrl: `${url.origin}/favicon.ico`,
    };
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function getAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function metaContent(html: string, names: readonly string[]): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const wanted = new Set(names);
  for (const tag of tags) {
    const property = getAttribute(tag, 'property') ?? getAttribute(tag, 'name');
    if (!property || !wanted.has(property.toLowerCase())) continue;
    const content = getAttribute(tag, 'content');
    if (content) return decodeHtmlEntities(content);
  }
  return null;
}

function absoluteImage(raw: string | null, source: URL): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw, source);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Lit les balises Open Graph / HTML sans exécuter le document. */
export function parseHtmlLinkPreview(html: string, rawUrl: string): Partial<LinkPreview> | null {
  let source: URL;
  try {
    source = new URL(rawUrl);
  } catch {
    return null;
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title =
    metaContent(html, ['og:title', 'twitter:title']) ??
    (titleTag ? decodeHtmlEntities(titleTag) : null);
  const description = metaContent(html, [
    'og:description',
    'twitter:description',
    'description',
  ]);
  const image = metaContent(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  if (!title && !description && !image) return null;
  return {
    ...(title ? { title: truncate(title, TITLE_MAX) } : {}),
    ...(description ? { description: truncate(description, DESCRIPTION_MAX) } : {}),
    imageUrl: absoluteImage(image, source),
  };
}

export function mergeLinkPreview(base: LinkPreview, patch: Partial<LinkPreview>): LinkPreview {
  return {
    ...base,
    ...patch,
    title: patch.title?.trim() || base.title,
    description: patch.description?.trim() || base.description,
    imageUrl: patch.imageUrl ?? base.imageUrl,
  };
}
