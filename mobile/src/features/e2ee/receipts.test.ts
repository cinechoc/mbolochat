import { describe, expect, it } from 'vitest';

import type { MessageReceipt } from '@/lib/types';

import {
  canMarkRead,
  canReportDelivered,
  deliveredIds,
  mergeReceipts,
  receiptState,
} from './receipts';

const receipt = (over: Partial<MessageReceipt> = {}): MessageReceipt => ({
  messageId: 'm1',
  userId: 'peer',
  deliveredAt: null,
  readAt: null,
  ...over,
});

describe('receiptState — « Reçu » puis « Ouvert »', () => {
  it('aucun accusé : aucun statut', () => {
    expect(receiptState([], 'me')).toBe('none');
    expect(receiptState(undefined, 'me')).toBe('none');
  });

  it('message livré mais non lu : « Reçu »', () => {
    expect(receiptState([receipt({ deliveredAt: '2024-01-01T10:00:00Z' })], 'me')).toBe('delivered');
  });

  it('message lu : « Ouvert »', () => {
    expect(
      receiptState(
        [receipt({ deliveredAt: '2024-01-01T10:00:00Z', readAt: '2024-01-01T10:01:00Z' })],
        'me',
      ),
    ).toBe('read');
  });

  it('« Ouvert » reste définitif même si le destinataire disparaît de la présence', () => {
    // La lecture est acquise : la présence ne la révoque jamais.
    const stored = [receipt({ deliveredAt: null, readAt: '2024-01-01T10:01:00Z' })];
    expect(receiptState(stored, 'me', false)).toBe('read');
  });

  it('« Reçu » disparaît quand le destinataire se déconnecte avant d’avoir lu', () => {
    const stored = [receipt({ deliveredAt: '2024-01-01T10:00:00Z' })];
    expect(receiptState(stored, 'me', false)).toBe('none');
    // Reconnexion sans lecture : la livraison confirmée + présence le fait réapparaître.
    expect(receiptState(stored, 'me', true)).toBe('delivered');
  });

  it("l'accusé de l'auteur lui-même ne compte pas", () => {
    expect(receiptState([receipt({ userId: 'me', readAt: '2024-01-01T10:01:00Z' })], 'me')).toBe(
      'none',
    );
  });

  it('un seul destinataire ayant lu suffit pour « Ouvert »', () => {
    const receipts = [
      receipt({ userId: 'a', deliveredAt: '2024-01-01T10:00:00Z' }),
      receipt({ userId: 'b', readAt: '2024-01-01T10:02:00Z' }),
    ];
    expect(receiptState(receipts, 'me')).toBe('read');
  });
});

describe('mergeReceipts — ordre et idempotence', () => {
  it('fusionne par message et par destinataire', () => {
    const merged = mergeReceipts(
      {},
      [
        receipt({ userId: 'a', deliveredAt: '2024-01-01T10:00:00Z' }),
        receipt({ userId: 'b', deliveredAt: '2024-01-01T10:00:30Z' }),
      ],
    );
    expect(merged.m1).toHaveLength(2);
  });

  it('un accusé tardif plus faible ne fait pas perdre la lecture', () => {
    const first = mergeReceipts({}, [receipt({ readAt: '2024-01-01T10:01:00Z' })]);
    const again = mergeReceipts(first, [receipt({ deliveredAt: '2024-01-01T10:00:00Z' })]);
    expect(again.m1[0].readAt).toBe('2024-01-01T10:01:00Z');
    expect(receiptState(again.m1, 'me')).toBe('read');
  });

  it('rejouer le même événement est sans effet (idempotence)', () => {
    const event = [receipt({ deliveredAt: '2024-01-01T10:00:00Z' })];
    const once = mergeReceipts({}, event);
    const twice = mergeReceipts(once, event);
    expect(twice.m1).toHaveLength(1);
    expect(twice.m1[0].deliveredAt).toBe('2024-01-01T10:00:00Z');
  });

  it('un événement vide ne modifie pas l’état', () => {
    const current = { m1: [receipt({ readAt: '2024-01-01T10:01:00Z' })] };
    expect(mergeReceipts(current, [])).toBe(current);
  });
});

describe('deliveredIds — ce que l’appareil a réellement reçu', () => {
  it('ne retient que les messages des autres, sans doublon', () => {
    const ids = deliveredIds([
      { id: 'a', mine: 0 },
      { id: 'b', mine: 1 },
      { id: 'a', mine: 0 },
      { id: '', mine: 0 },
    ]);
    expect(ids).toEqual(['a']);
  });
});

describe('canMarkRead — ouverture réelle seulement', () => {
  it('exige écran au premier plan, application active et liste prête', () => {
    expect(canMarkRead({ focused: true, appActive: true, ready: true })).toBe(true);
    expect(canMarkRead({ focused: false, appActive: true, ready: true })).toBe(false);
    expect(canMarkRead({ focused: true, appActive: false, ready: true })).toBe(false);
    expect(canMarkRead({ focused: true, appActive: true, ready: false })).toBe(false);
  });
});

describe('canReportDelivered — accusat de livraison au premier plan seulement', () => {
  it('exige application active et liste prête (pas de focus par écran)', () => {
    expect(canReportDelivered({ appActive: true, ready: true })).toBe(true);
    expect(canReportDelivered({ appActive: false, ready: true })).toBe(false);
    expect(canReportDelivered({ appActive: true, ready: false })).toBe(false);
    expect(canReportDelivered({ appActive: false, ready: false })).toBe(false);
  });
});
