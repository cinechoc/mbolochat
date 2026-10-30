import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type CallMedia = 'AUDIO' | 'VIDEO';

/**
 * Limites d'un appel de groupe en maillage. Chaque participant envoie un flux
 * à tous les autres : la bande passante montante d'une connexion mobile
 * gabonaise sature vite, d'où un plafond vidéo plus bas qu'en audio.
 */
export const DEFAULT_MAX_GROUP_AUDIO = 8;
export const DEFAULT_MAX_GROUP_VIDEO = 4;

/** Personne ne rejoint l'appel lancé : on l'éteint sans laisser de trace. */
export const GROUP_CALL_EXPIRE_MS = 90_000;
/** Socket tombé : on laisse l'appareil revenir avant de retirer sa tuile. */
export const GROUP_CALL_DISCONNECT_GRACE_MS = 12_000;

@Injectable()
export class CallLimits {
  constructor(private readonly config: ConfigService) {}

  /** Plafond du maillage selon le média de l'appel, ajustable par variable d'environnement. */
  maxParticipants(media: CallMedia): number {
    const fallback = media === 'VIDEO' ? DEFAULT_MAX_GROUP_VIDEO : DEFAULT_MAX_GROUP_AUDIO;
    const key = media === 'VIDEO' ? 'CALL_MAX_VIDEO' : 'CALL_MAX_AUDIO';
    const raw = this.config.get<string>(key);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
