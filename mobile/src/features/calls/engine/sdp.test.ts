import { describe, expect, it } from 'vitest';

import { OPUS_MAX_KBPS, opusPayloadType, tuneOpusSdp } from './sdp';

const SDP_WITH_FMTP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10',
  'a=sendrecv',
].join('\r\n');

const SDP_WITHOUT_FMTP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
].join('\r\n');

describe('tuneOpusSdp', () => {
  it('complète la ligne fmtp existante sans écraser ses paramètres', () => {
    const tuned = tuneOpusSdp(SDP_WITH_FMTP);
    expect(tuned).toContain('a=fmtp:111 minptime=10;usedtx=1;useinbandfec=1;maxaveragebitrate=28000');
    expect(tuned).toContain('\r\n');
  });

  it('crée la ligne fmtp quand elle manque', () => {
    const tuned = tuneOpusSdp(SDP_WITHOUT_FMTP);
    expect(tuned).toContain('a=rtpmap:111 opus/48000/2');
    expect(tuned).toContain('a=fmtp:111 usedtx=1;useinbandfec=1;maxaveragebitrate=28000');
  });

  it('ne duplique pas les paramètres déjà présents', () => {
    const tuned = tuneOpusSdp('a=rtpmap:109 opus/48000/2\r\na=fmtp:109 usedtx=1');
    expect(tuned.match(/usedtx=1/g)).toHaveLength(1);
    expect(tuned).toContain('useinbandfec=1');
  });

  it('respecte le plafond demandé', () => {
    const tuned = tuneOpusSdp(SDP_WITH_FMTP, 24);
    expect(tuned).toContain('maxaveragebitrate=24000');
    expect(OPUS_MAX_KBPS).toBe(28);
  });

  it('laisse intact un SDP sans Opus', () => {
    const videoOnly = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000';
    expect(tuneOpusSdp(videoOnly)).toBe(videoOnly);
  });

  it('retrouve le payload type Opus', () => {
    expect(opusPayloadType(SDP_WITH_FMTP)).toBe('111');
    expect(opusPayloadType('v=0')).toBeNull();
  });
});
