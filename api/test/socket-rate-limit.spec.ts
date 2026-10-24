import { describe, expect, it } from 'vitest';
import {
  MESSAGE_RATE_LIMIT,
  MESSAGE_RATE_WINDOW_MS,
  PRESENCE_RATE_LIMIT,
  PRESENCE_RATE_WINDOW_MS,
  SocketRateLimiter,
} from '../src/chat/socket-rate-limit.js';

describe('SocketRateLimiter', () => {
  it('autorise 10 événements de présence puis refuse, sans déconnecter', () => {
    const limiter = new SocketRateLimiter();
    for (let index = 0; index < PRESENCE_RATE_LIMIT; index += 1) {
      expect(limiter.allowPresence('alice', 0)).toBe(true);
    }
    expect(limiter.allowPresence('alice', 0)).toBe(false);
    expect(limiter.allowPresence('alice', PRESENCE_RATE_WINDOW_MS - 1)).toBe(false);
    expect(limiter.allowPresence('alice', PRESENCE_RATE_WINDOW_MS)).toBe(true);
  });

  it('autorise 30 messages par minute puis refuse', () => {
    const limiter = new SocketRateLimiter();
    for (let index = 0; index < MESSAGE_RATE_LIMIT; index += 1) {
      expect(limiter.allowMessage('alice', 0)).toBe(true);
    }
    expect(limiter.allowMessage('alice', 0)).toBe(false);
    expect(limiter.allowMessage('alice', MESSAGE_RATE_WINDOW_MS - 1)).toBe(false);
    expect(limiter.allowMessage('alice', MESSAGE_RATE_WINDOW_MS)).toBe(true);
  });

  it('compte par utilisateur, tous appareils confondus', () => {
    const limiter = new SocketRateLimiter();
    for (let index = 0; index < PRESENCE_RATE_LIMIT; index += 1) {
      expect(limiter.allowPresence('alice', 0)).toBe(true);
    }
    // Le même compte depuis un autre socket est déjà au plafond.
    expect(limiter.allowPresence('alice', 1)).toBe(false);
    // Un autre compte garde son propre quota.
    expect(limiter.allowPresence('bob', 1)).toBe(true);
  });

  it('sépare les quotas présence et messages', () => {
    const limiter = new SocketRateLimiter();
    for (let index = 0; index < PRESENCE_RATE_LIMIT; index += 1) {
      expect(limiter.allowPresence('alice', 0)).toBe(true);
    }
    expect(limiter.allowPresence('alice', 0)).toBe(false);
    expect(limiter.allowMessage('alice', 0)).toBe(true);
  });

  it('libère progressivement la fenêtre glissante', () => {
    const limiter = new SocketRateLimiter();
    for (let index = 0; index < PRESENCE_RATE_LIMIT; index += 1) {
      expect(limiter.allowPresence('alice', index * 1000)).toBe(true);
    }
    expect(limiter.allowPresence('alice', 10_000)).toBe(true);
    expect(limiter.allowPresence('alice', 10_000)).toBe(false);
  });
});
