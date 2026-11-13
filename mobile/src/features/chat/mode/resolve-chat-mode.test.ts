import { describe, expect, it } from 'vitest';

import type { ConversationSummary, MemberInfo } from '@/lib/types';
import { resolveChatMode } from './resolve-chat-mode';

const member = (id: string, displayName: string): MemberInfo => ({
  id,
  username: id,
  displayName,
  avatarUrl: null,
  gender: null,
  genderCustom: null,
  lastReadAt: null,
  role: 'member',
});

const summary = (input: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'conversation-1',
  type: 'DIRECT',
  name: null,
  avatarUrl: null,
  emoji: null,
  color: null,
  description: null,
  ownerId: null,
  whoCanSend: 'all',
  whoCanAdd: 'all',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  e2eeSince: null,
  members: [member('me', 'Moi'), member('peer', 'Pair')],
  lastMessage: null,
  unreadCount: 0,
  pinned: false,
  muted: false,
  hidden: false,
  myRole: 'member',
  blockedByMe: false,
  blockedByThem: false,
  ...input,
});

const base = {
  conversationId: 'conversation-1',
  serverSummary: null,
  cachedSummary: null,
  e2eeEnabled: true,
  currentUserId: 'me',
  online: true,
};

describe('resolveChatMode', () => {
  it('choisit le chiffré quand le serveur le déclare sur une discussion directe', () => {
    const result = resolveChatMode({
      ...base,
      serverSummary: summary({ e2eeSince: '2026-01-01T00:00:00.000Z' }),
    });
    expect(result.kind).toBe('e2ee');
  });

  it('utilise le cache local hors ligne pour une conversation chiffrée', () => {
    const result = resolveChatMode({
      ...base,
      cachedSummary: summary({ e2eeSince: '2026-01-01T00:00:00.000Z' }),
      online: false,
    });
    expect(result.kind).toBe('e2ee');
  });

  it('reste en attente sans résumé : jamais de repli clair', () => {
    expect(resolveChatMode({ ...base, online: false })).toEqual({
      kind: 'pending',
      reason: 'summary_unknown',
    });
    expect(resolveChatMode({ ...base, online: true })).toEqual({
      kind: 'pending',
      reason: 'summary_unknown',
    });
  });

  it('reste en attente quand le cache ne porte pas le champ e2eeSince', () => {
    const legacy = { ...summary({ e2eeSince: null }) } as Record<string, unknown>;
    delete legacy.e2eeSince;
    const result = resolveChatMode({
      ...base,
      cachedSummary: legacy as unknown as ConversationSummary,
      online: false,
    });
    expect(result).toEqual({ kind: 'pending', reason: 'summary_unknown' });
  });

  it('choisit le clair pour un résumé complet dont e2eeSince est null', () => {
    const result = resolveChatMode({ ...base, cachedSummary: summary({ e2eeSince: null }) });
    expect(result.kind).toBe('classic');
  });

  it('bloque un groupe marqué e2eeSince au lieu de le basculer en clair', () => {
    const result = resolveChatMode({
      ...base,
      serverSummary: summary({
        type: 'GROUP',
        e2eeSince: '2026-01-01T00:00:00.000Z',
        members: [member('me', 'Moi'), member('peer', 'Pair'), member('third', 'Tiers')],
      }),
    });
    expect(result).toEqual({ kind: 'blocked', reason: 'group_mismatch' });
  });

  it('bloque une conversation chiffrée sans correspondant identifiable', () => {
    const result = resolveChatMode({
      ...base,
      serverSummary: summary({
        e2eeSince: '2026-01-01T00:00:00.000Z',
        members: [member('me', 'Moi')],
      }),
    });
    expect(result).toEqual({ kind: 'blocked', reason: 'peer_missing' });
  });

  it('respecte le drapeau E2EE désactivé comme configuration explicite', () => {
    const result = resolveChatMode({
      ...base,
      e2eeEnabled: false,
      serverSummary: summary({ e2eeSince: '2026-01-01T00:00:00.000Z' }),
    });
    expect(result.kind).toBe('classic');
  });

  it('ignore un résumé qui ne concerne pas la conversation demandée', () => {
    const result = resolveChatMode({
      ...base,
      cachedSummary: summary({ id: 'autre-conversation', e2eeSince: null }),
    });
    expect(result).toEqual({ kind: 'pending', reason: 'summary_unknown' });
  });
});
