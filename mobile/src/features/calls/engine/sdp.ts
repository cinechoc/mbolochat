/** Réglages Opus appliqués aux SDP locaux : débit modéré, silence supprimé, FEC. */
export const OPUS_MAX_KBPS = 28;

/**
 * Active DTX, la correction d'erreurs et plafonne le débit Opus dans un SDP.
 *
 * react-native-webrtc n'expose pas `setCodecPreferences` de façon fiable :
 * on complète donc la ligne `a=fmtp` du codec Opus avant de poser la
 * description locale. Sans ligne Opus (appel vidéo sans audio), rien ne change.
 */
export function tuneOpusSdp(sdp: string, maxKbps: number = OPUS_MAX_KBPS): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r\n|\n/);
  const rtpmapIndex = lines.findIndex((line) => /^a=rtpmap:\d+\s+opus\/48000\/2/i.test(line));
  if (rtpmapIndex === -1) {
    return sdp;
  }
  const payload = lines[rtpmapIndex].match(/^a=rtpmap:(\d+)/)?.[1];
  if (!payload) {
    return sdp;
  }
  const fmtpPattern = new RegExp(`^a=fmtp:${payload}\\s`);
  const fmtpIndex = lines.findIndex((line) => fmtpPattern.test(line));
  const additions = [
    ['usedtx', '1'],
    ['useinbandfec', '1'],
    ['maxaveragebitrate', String(maxKbps * 1000)],
  ] as const;

  if (fmtpIndex >= 0) {
    let line = lines[fmtpIndex];
    for (const [key, value] of additions) {
      if (!new RegExp(`(?:^|[\\s;])${key}=`).test(line)) {
        line += `;${key}=${value}`;
      }
    }
    lines[fmtpIndex] = line;
  } else {
    const extra = additions.map(([key, value]) => `${key}=${value}`).join(';');
    lines.splice(rtpmapIndex + 1, 0, `a=fmtp:${payload} ${extra}`);
  }
  return lines.join(eol);
}

/** Payload type Opus d'un SDP (absent si le média est muet ou sans Opus). */
export function opusPayloadType(sdp: string): string | null {
  const line = sdp.split(/\r\n|\n/).find((entry) => /^a=rtpmap:\d+\s+opus\/48000\/2/i.test(entry));
  return line?.match(/^a=rtpmap:(\d+)/)?.[1] ?? null;
}
