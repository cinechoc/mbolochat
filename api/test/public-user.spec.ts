import { describe, expect, it } from 'vitest';

import type { User } from '../src/db/schema.js';
import { toPublicUser } from '../src/users/users.service.js';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'mbolo@example.com',
    username: 'mbolo',
    displayName: 'Mbolo',
    bio: null,
    notificationsEnabled: true,
    notificationSound: true,
    notificationPreview: true,
    passwordHash: 'hash',
    avatarUrl: null,
    birthday: null,
    gender: 'FEMALE',
    lastSeenAt: null,
    lastSeenVisibility: 'contacts',
    onlineVisibility: 'same_as_last_seen',
    city: null,
    country: null,
    cityUpdatedAt: null,
    profileVisibility: 'everyone',
    writePermission: 'everyone',
    groupAddPermission: 'contacts',
    callPermission: 'everyone',
    discoverability: 'everyone',
    readReceipts: true,
    typingIndicator: true,
    notifyMessages: true,
    notifyGroups: true,
    notifyMentions: true,
    notifyCalls: true,
    notifyReactions: true,
    quietHoursEnabled: false,
    quietStartMinute: 1320,
    quietEndMinute: 420,
    quietUtcOffsetMinutes: 0,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('toPublicUser', () => {
  it('expose le genre déclaré pour choisir l’avatar par défaut', () => {
    expect(toPublicUser(user()).gender).toBe('FEMALE');
    expect(toPublicUser(user({ gender: 'MALE' })).gender).toBe('MALE');
    expect(toPublicUser(user({ gender: 'CUSTOM' })).gender).toBe('CUSTOM');
  });

  it('préserve un genre absent sans en inventer un', () => {
    expect(toPublicUser(user({ gender: null })).gender).toBeNull();
  });
});
