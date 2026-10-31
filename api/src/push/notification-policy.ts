/** Heures calmes et mentions : décisions pures, testées sans base ni réseau. */

export function quietHoursActive(
  enabled: boolean,
  startMinute: number,
  endMinute: number,
  utcOffsetMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!enabled) {
    return false;
  }
  const local = ((now.getUTCHours() * 60 + now.getUTCMinutes() + utcOffsetMinutes) % 1440 + 1440) % 1440;
  if (startMinute === endMinute) {
    return true;
  }
  return startMinute < endMinute
    ? local >= startMinute && local < endMinute
    : local >= startMinute || local < endMinute;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Le texte cite-t-il `@pseudo` (majuscules et ponctuation autour tolérées) ? */
export function mentionsUser(content: string, username: string): boolean {
  if (!content || !username) {
    return false;
  }
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_])@${escapeRegExp(username)}(?![\\p{L}\\p{N}_])`,
    'iu',
  );
  return pattern.test(content);
}

export type NotificationCategoryInput = {
  isGroup: boolean;
  mention: boolean;
  notifyMessages: boolean;
  notifyGroups: boolean;
  notifyMentions: boolean;
};

/**
 * Catégorie de notification : un message direct suit « messages » ; dans un
 * groupe, « groupes » ou une mention explicitement autorisée.
 */
export function messageNotificationAllowed(input: NotificationCategoryInput): boolean {
  if (input.isGroup) {
    return input.notifyGroups || (input.mention && input.notifyMentions);
  }
  return input.notifyMessages;
}
