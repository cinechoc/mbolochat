import { describe, expect, it } from 'vitest';

import { groupUnreadCount } from './conversationFilters';

function row(type: string, unreadCount: number) {
  return { type, unreadCount };
}

describe('groupUnreadCount', () => {
  it('additionne les non-lus des groupes seulement', () => {
    expect(
      groupUnreadCount([
        row('GROUP', 2),
        row('DIRECT', 5),
        row('GROUP', 3),
        row('DIRECT', 0),
      ]),
    ).toBe(5);
  });

  it('ne compte pas les groupes sans non-lus', () => {
    expect(groupUnreadCount([row('GROUP', 0), row('GROUP', 0)])).toBe(0);
  });

  it('ignore les valeurs négatives', () => {
    expect(groupUnreadCount([row('GROUP', -2)])).toBe(0);
  });
});
