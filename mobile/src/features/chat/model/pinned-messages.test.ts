import { describe, expect, it, vi } from 'vitest';

import {
  MAX_PINNED_MESSAGES,
  parsePinnedMessageIds,
  pinnedMessagesStorageKey,
  togglePinnedMessageId,
} from './pinned-messages';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

describe('messages épinglés locaux', () => {
  it('ignore les valeurs illisibles ou invalides', () => {
    expect(parsePinnedMessageIds(null)).toEqual([]);
    expect(parsePinnedMessageIds('{')).toEqual([]);
    expect(parsePinnedMessageIds(JSON.stringify(['m1', 3, '', 'm1', 'm2']))).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('épingle puis désépingle sans muter la liste', () => {
    const initial = ['m1'];
    expect(togglePinnedMessageId(initial, 'm2')).toEqual(['m2', 'm1']);
    expect(initial).toEqual(['m1']);
    expect(togglePinnedMessageId(initial, 'm1')).toEqual([]);
  });

  it('borne le nombre d’épingles persistées', () => {
    const many = Array.from({ length: MAX_PINNED_MESSAGES + 3 }, (_, index) => `m${index}`);
    expect(parsePinnedMessageIds(JSON.stringify(many))).toHaveLength(MAX_PINNED_MESSAGES);
    expect(togglePinnedMessageId(many, 'nouveau')).toHaveLength(MAX_PINNED_MESSAGES);
  });

  it('isole le stockage par conversation', () => {
    expect(pinnedMessagesStorageKey('conv-a')).not.toBe(pinnedMessagesStorageKey('conv-b'));
  });
});
