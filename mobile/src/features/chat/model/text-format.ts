export interface FormattedSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
}

const MARKERS = [
  { marker: '**', style: 'bold' },
  { marker: '`', style: 'mono' },
  { marker: '~', style: 'strike' },
  { marker: '*', style: 'italic' },
] as const;

type SegmentStyle = Omit<FormattedSegment, 'text'>;

function mergeSegments(segments: FormattedSegment[]): FormattedSegment[] {
  const merged: FormattedSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.bold === segment.bold &&
      previous.italic === segment.italic &&
      previous.strike === segment.strike &&
      previous.mono === segment.mono
    ) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function parseRange(
  input: string,
  start: number,
  end: number,
  style: SegmentStyle,
): FormattedSegment[] {
  const segments: FormattedSegment[] = [];
  let buffer = '';
  let index = start;

  const flush = () => {
    if (buffer) {
      segments.push({ text: buffer, ...style });
      buffer = '';
    }
  };

  while (index < end) {
    if (input[index] === '\\' && index + 1 < end) {
      buffer += input[index + 1];
      index += 2;
      continue;
    }

    const token = MARKERS.find((entry) => input.startsWith(entry.marker, index));
    if (!token) {
      buffer += input[index];
      index += 1;
      continue;
    }

    const contentStart = index + token.marker.length;
    let close = input.indexOf(token.marker, contentStart);
    if (close !== -1 && token.marker.length === 2) {
      // Une suite de trois étoiles ferme l'italique imbriquée puis le gras :
      // `**gras *aussi***` doit utiliser les deux dernières étoiles pour le gras.
      let runEnd = close;
      while (runEnd < end && input[runEnd] === token.marker[0]) runEnd += 1;
      if (runEnd - close > token.marker.length) close = runEnd - token.marker.length;
    }
    if (close < contentStart || close >= end) {
      buffer += token.marker;
      index = contentStart;
      continue;
    }

    flush();
    const nextStyle: SegmentStyle =
      token.style === 'mono'
        ? { ...style, mono: true }
        : { ...style, [token.style]: true };
    if (token.style === 'mono') {
      segments.push({ text: input.slice(contentStart, close), ...nextStyle });
    } else {
      segments.push(...parseRange(input, contentStart, close, nextStyle));
    }
    index = close + token.marker.length;
  }

  flush();
  return segments;
}

/** Découpe un texte en segments de mise en forme locale, sans dépendance au rendu. */
export function parseFormattedText(input: string): FormattedSegment[] {
  return mergeSegments(parseRange(input, 0, input.length, {}));
}

/** Texte brut, utilisé pour compter les emoji et les aperçus de notification. */
export function stripFormatting(input: string): string {
  return parseFormattedText(input)
    .map((segment) => segment.text)
    .join('');
}
