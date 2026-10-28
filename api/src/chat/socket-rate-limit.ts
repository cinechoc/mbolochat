import { Injectable } from '@nestjs/common';

export const PRESENCE_RATE_LIMIT = 10;
export const PRESENCE_RATE_WINDOW_MS = 10_000;
export const MESSAGE_RATE_LIMIT = 30;
export const MESSAGE_RATE_WINDOW_MS = 60_000;
export const CALL_RATE_LIMIT = 5;
export const CALL_RATE_WINDOW_MS = 60_000;

/**
 * Limitation en mémoire, par utilisateur (pas par socket) : deux appareils du
 * même compte partagent le même quota. Au-delà du seuil, l'événement est refusé
 * sans fermer la connexion.
 */
@Injectable()
export class SocketRateLimiter {
  private readonly presenceHits = new Map<string, number[]>();
  private readonly messageHits = new Map<string, number[]>();
  private readonly callHits = new Map<string, number[]>();

  allowPresence(userId: string, now = Date.now()): boolean {
    return this.hit(
      this.presenceHits,
      userId,
      now,
      PRESENCE_RATE_WINDOW_MS,
      PRESENCE_RATE_LIMIT,
    );
  }

  allowMessage(userId: string, now = Date.now()): boolean {
    return this.hit(
      this.messageHits,
      userId,
      now,
      MESSAGE_RATE_WINDOW_MS,
      MESSAGE_RATE_LIMIT,
    );
  }

  allowCall(userId: string, now = Date.now()): boolean {
    return this.hit(this.callHits, userId, now, CALL_RATE_WINDOW_MS, CALL_RATE_LIMIT);
  }

  private hit(
    hits: Map<string, number[]>,
    userId: string,
    now: number,
    windowMs: number,
    limit: number,
  ): boolean {
    const recent = (hits.get(userId) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    hits.set(userId, recent);
    return true;
  }
}
