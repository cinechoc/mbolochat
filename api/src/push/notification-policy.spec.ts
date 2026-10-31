import { describe, expect, it } from 'vitest';

import {
  mentionsUser,
  messageNotificationAllowed,
  quietHoursActive,
} from './notification-policy.js';

describe('quietHoursActive', () => {
  const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 0, 1, hour, minute));

  it('reste inactif quand le réglage est coupé', () => {
    expect(quietHoursActive(false, 1320, 420, 60, at(3))).toBe(false);
  });

  it('gère une plage qui traverse minuit', () => {
    // 22:00 → 07:00, heure locale = UTC+1
    expect(quietHoursActive(true, 1320, 420, 60, at(21, 30))).toBe(true); // 22:30 local
    expect(quietHoursActive(true, 1320, 420, 60, at(4, 30))).toBe(true); // 05:30 local
    expect(quietHoursActive(true, 1320, 420, 60, at(11))).toBe(false); // 12:00 local
  });

  it('gère une plage en journée', () => {
    expect(quietHoursActive(true, 540, 720, 0, at(10))).toBe(true);
    expect(quietHoursActive(true, 540, 720, 0, at(8, 59))).toBe(false);
    expect(quietHoursActive(true, 540, 720, 0, at(12))).toBe(false);
  });
});

describe('mentionsUser', () => {
  it('détecte le pseudo avec ponctuation et casse', () => {
    expect(mentionsUser('Salut @jean.ndong !', 'jean.ndong')).toBe(true);
    expect(mentionsUser('@JEAN.NDONG, tu viens ?', 'jean.ndong')).toBe(true);
  });

  it('ne confond pas un préfixe de pseudo', () => {
    expect(mentionsUser('@jean.ndong2 bonjour', 'jean.ndong')).toBe(false);
    expect(mentionsUser('@autre chose', 'jean.ndong')).toBe(false);
  });
});

describe('messageNotificationAllowed', () => {
  const base = {
    isGroup: false,
    mention: false,
    notifyMessages: true,
    notifyGroups: true,
    notifyMentions: true,
  };

  it('suit la catégorie directe', () => {
    expect(messageNotificationAllowed(base)).toBe(true);
    expect(messageNotificationAllowed({ ...base, notifyMessages: false })).toBe(false);
  });

  it('autorise une mention même si les groupes sont coupés', () => {
    expect(
      messageNotificationAllowed({
        ...base,
        isGroup: true,
        notifyGroups: false,
        mention: true,
      }),
    ).toBe(true);
    expect(
      messageNotificationAllowed({
        ...base,
        isGroup: true,
        notifyGroups: false,
        mention: true,
        notifyMentions: false,
      }),
    ).toBe(false);
  });
});
