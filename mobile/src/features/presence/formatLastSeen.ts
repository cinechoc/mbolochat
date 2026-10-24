const WEEKDAYS = [
  'dimanche',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
] as const;

const pad = (value: number) => (value < 10 ? `0${value}` : String(value));

function localDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortDate(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/**
 * « vu il y a… » en français. `online` couvre la ligne « en ligne » ; le reste
 * suit les paliers demandés, en heure locale du téléphone.
 */
export function formatLastSeen(
  lastSeenAt: Date | string | null | undefined,
  now: Date,
  online = false,
): string {
  if (online) return 'en ligne';
  if (!lastSeenAt) return '';
  const date = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getTime() > now.getTime()) return "vu à l'instant";

  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return "vu à l'instant";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `vu il y a ${minutes} min`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 6) return `vu il y a ${hours} h`;

  const days = localDayNumber(now) - localDayNumber(date);
  if (days <= 0) return `vu aujourd'hui à ${clock(date)}`;
  if (days === 1) return `vu hier à ${clock(date)}`;
  if (days <= 6) return `vu ${WEEKDAYS[date.getDay()]} à ${clock(date)}`;
  return `vu le ${shortDate(date)}`;
}
