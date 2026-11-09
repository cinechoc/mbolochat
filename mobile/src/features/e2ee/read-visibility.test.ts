import { describe, expect, it } from 'vitest';

import { visibleForeignMessageIds } from './read-visibility';
import type { E2eeListRow } from './rows';
import type { StoredE2eeMessage } from './db';

const message = (over: Partial<StoredE2eeMessage> = {}): StoredE2eeMessage =>
  ({
    id: 'm1',
    conversation_id: 'c1',
    sender_id: 'peer',
    sender_name: 'Peer',
    body: 'hello',
    created_at: '2024-01-01T10:00:00Z',
    client_id: 'c1',
    mine: 0,
    ...over,
  }) as StoredE2eeMessage;

const row = (messageValue: StoredE2eeMessage): { key: string; item: E2eeListRow } => ({
  key: messageValue.id,
  item: { key: messageValue.id, type: 'message', message: messageValue, continuation: false },
});

describe('visibleForeignMessageIds — lecture réelle seulement', () => {
  it('retient les messages étrangers visibles', () => {
    expect(visibleForeignMessageIds([row(message({ id: 'a' })), row(message({ id: 'b' }))])).toEqual([
      'a',
      'b',
    ]);
  });

  it('exclut les messages propres', () => {
    expect(
      visibleForeignMessageIds([row(message({ id: 'mine', mine: 1 })), row(message({ id: 'peer' }))]),
    ).toEqual(['peer']);
  });

  it('ignore les séparateurs et les lignes vagues ou dupliquées', () => {
    const items = [
      { key: 'date-a', item: { key: 'date-a', type: 'date', label: '1 janvier' } as E2eeListRow },
      { key: 'time-a', item: { key: 'time-a', type: 'time', label: '10 h' } as E2eeListRow },
      row(message({ id: 'a' })),
      row(message({ id: 'a' })),
    ];
    expect(visibleForeignMessageIds(items)).toEqual(['a']);
  });

  it('entrée vide ou illisible : aucun identifiant', () => {
    expect(visibleForeignMessageIds([])).toEqual([]);
    // Les illisibles restent visibles à l'écran : la bulle « non pris en
    // charge » est consultée comme un message réel.
    const unreadable = message({ id: 'u', body: '', unreadable_reason: 'unsupported_version' });
    expect(visibleForeignMessageIds([row(unreadable)])).toEqual(['u']);
  });
});
