import type { EncryptedLinkPreview } from '@/features/e2ee/payload';

export interface TextSendOptions {
  silent?: boolean;
  viewOnce?: boolean;
  /** Date ISO à laquelle l’outbox peut commencer l’envoi. */
  scheduledAt?: string | null;
  /** Aperçu déjà résolu ; utilisé par l'enveloppe chiffrée, ignoré en clair. */
  preview?: EncryptedLinkPreview | null;
}

export const MIN_SCHEDULE_DELAY_MS = 60_000;
export const MAX_SCHEDULE_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export function scheduledDate(value: string | null | undefined, now = new Date()): Date | null {
  if (!value) return null;
  const date = new Date(value);
  const delay = date.getTime() - now.getTime();
  if (!Number.isFinite(date.getTime())) return null;
  if (delay < MIN_SCHEDULE_DELAY_MS || delay >= MAX_SCHEDULE_DELAY_MS) return null;
  return date;
}

export function isValidScheduledAt(value: string | null | undefined, now = new Date()): boolean {
  return scheduledDate(value, now) !== null;
}

/** Prochaine heure ronde, au moins une heure après maintenant. */
export function defaultScheduledAt(now = new Date()): Date {
  const date = new Date(now.getTime() + 60 * 60_000);
  date.setSeconds(0, 0);
  const remainder = date.getMinutes() % 5;
  if (remainder !== 0) date.setMinutes(date.getMinutes() + (5 - remainder));
  return date;
}

export function normalizedSendOptions(
  input: TextSendOptions | undefined,
  now = new Date(),
): TextSendOptions | undefined {
  if (!input) return undefined;
  const options: TextSendOptions = {};
  if (input.silent === true) options.silent = true;
  if (input.viewOnce === true) options.viewOnce = true;
  if (input.scheduledAt) {
    if (!isValidScheduledAt(input.scheduledAt, now)) {
      throw new Error('scheduled_at_invalide');
    }
    options.scheduledAt = new Date(input.scheduledAt).toISOString();
  }
  return Object.keys(options).length > 0 ? options : undefined;
}
