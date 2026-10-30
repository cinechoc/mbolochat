import { describe, expect, it } from 'vitest';

import { iceRank, orderIceUrls } from './ice-servers.util.js';

describe('ordre des serveurs ICE', () => {
  it('classe STUN, TURN UDP, TURN TCP puis TURN TLS', () => {
    expect(iceRank('stun:stun.l.google.com:19302')).toBe(0);
    expect(iceRank('turn:relay.example.com:80')).toBe(1);
    expect(iceRank('turn:relay.example.com:80?transport=tcp')).toBe(2);
    expect(iceRank('turns:relay.example.com:443?transport=tcp')).toBe(3);
  });

  it('place le TLS en dernier et le STUN en premier', () => {
    const ordered = orderIceUrls([
      'turns:relay.example.com:443?transport=tcp',
      'turn:relay.example.com:80?transport=tcp',
      'stun:stun.l.google.com:19302',
      'turn:relay.example.com:80',
    ]);
    expect(ordered).toEqual([
      'stun:stun.l.google.com:19302',
      'turn:relay.example.com:80',
      'turn:relay.example.com:80?transport=tcp',
      'turns:relay.example.com:443?transport=tcp',
    ]);
  });

  it('garde l’ordre d’origine à rang égal', () => {
    expect(orderIceUrls(['stun:b', 'stun:a'])).toEqual(['stun:b', 'stun:a']);
  });
});
