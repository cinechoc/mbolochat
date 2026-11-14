import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '@/lib/types';
import { chatRouteFor, directPeerOf, peerProfileRoute } from './routing';

function conversation(patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conv-1',
    type: 'DIRECT',
    name: null,
    avatarUrl: null,
    emoji: null,
    color: null,
    description: null,
    ownerId: null,
    whoCanSend: 'all',
    whoCanAdd: 'all',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    e2eeSince: null,
    members: [
      { id: 'me', username: 'moi', displayName: 'Moi', lastReadAt: null, role: 'member' },
      { id: 'peer-1', username: 'pair', displayName: 'Pair Test', lastReadAt: null, role: 'member' },
    ] as ConversationSummary['members'],
    lastMessage: null,
    unreadCount: 0,
    pinned: false,
    muted: false,
    hidden: false,
    myRole: 'member',
    blockedByMe: false,
    blockedByThem: false,
    ...patch,
  } as ConversationSummary;
}

describe('chatRouteFor — la route suit le serveur, jamais l’apparence', () => {
  it('une conversation classique reste sur l’écran en clair', () => {
    const route = chatRouteFor({
      conversation: conversation(),
      currentUserId: 'me',
      e2eeEnabled: true,
    });
    expect(route).toEqual({ kind: 'classic', pathname: '/chat/[id]', params: { id: 'conv-1' } });
  });

  it('une conversation chiffrée ouvre l’écran unifié, sans route distincte', () => {
    const route = chatRouteFor({
      conversation: conversation({ e2eeSince: '2026-01-02T00:00:00Z' }),
      currentUserId: 'me',
      e2eeEnabled: true,
    });
    expect(route).toEqual({ kind: 'classic', pathname: '/chat/[id]', params: { id: 'conv-1' } });
  });

  it('sans le drapeau E2EE du build, aucune redirection n’est inventée', () => {
    const route = chatRouteFor({
      conversation: conversation({ e2eeSince: '2026-01-02T00:00:00Z' }),
      currentUserId: 'me',
      e2eeEnabled: false,
    });
    expect(route.kind).toBe('classic');
  });

  it('refuse la navigation plutôt que de retomber sur l’écran en clair', () => {
    // Chiffrée mais aucun membre exploitable (liste absente) : pas de repli.
    const route = chatRouteFor({
      conversation: conversation({ e2eeSince: '2026-01-02T00:00:00Z', members: [] }),
      currentUserId: 'me',
      e2eeEnabled: true,
    });
    expect(route).toEqual({ kind: 'blocked', reason: 'peer_missing' });
  });

  it('refuse une conversation de groupe chiffrée (pas de correspondant unique)', () => {
    const route = chatRouteFor({
      conversation: conversation({
        type: 'GROUP',
        e2eeSince: '2026-01-02T00:00:00Z',
        members: [
          { id: 'me', username: 'moi', displayName: 'Moi' },
          { id: 'a', username: 'a', displayName: 'A' },
          { id: 'b', username: 'b', displayName: 'B' },
        ] as ConversationSummary['members'],
      }),
      currentUserId: 'me',
      e2eeEnabled: true,
    });
    expect(route.kind).toBe('blocked');
  });

  it('lit la liste partielle à un seul membre sans inventer d’identité', () => {
    const peer = directPeerOf(
      conversation({
        members: [
          { id: 'peer-9', username: 'pair9', displayName: '' },
        ] as ConversationSummary['members'],
      }),
      'me',
    );
    expect(peer).toEqual({
      id: 'peer-9',
      name: 'pair9',
      username: 'pair9',
      avatarUrl: null,
      gender: null,
    });
  });

  it('ne déduit jamais le correspondant du nom de la conversation', () => {
    // « name » peut être un libellé libre : il ne doit pas servir d'identité.
    const route = chatRouteFor({
      conversation: conversation({
        e2eeSince: '2026-01-02T00:00:00Z',
        name: 'Pair Test',
        members: [{ id: 'me', username: 'moi', displayName: 'Moi' }] as ConversationSummary['members'],
      }),
      currentUserId: 'me',
      e2eeEnabled: true,
    });
    expect(route.kind).toBe('blocked');
  });
});

describe('peerProfileRoute — le profil suit l’identifiant réel', () => {
  it('ouvre la fiche du correspondant avec son identifiant, jamais son nom', () => {
    const route = peerProfileRoute({
      peerId: 'peer-1',
      name: 'Pair Test',
      username: 'pair',
      avatarUrl: 'https://exemple/avatar.png',
      gender: 'FEMALE',
    });
    expect(route).toEqual({
      pathname: '/user/[id]',
      params: {
        id: 'peer-1',
        name: 'Pair Test',
        username: 'pair',
        avatar: 'https://exemple/avatar.png',
        gender: 'FEMALE',
      },
    });
    // L'identifiant est bien celui du serveur, pas le nom affiché.
    expect(route?.params.id).not.toBe('Pair Test');
  });

  it('sans identifiant, aucun profil n’est ouvert (pas de devinette)', () => {
    expect(peerProfileRoute({ peerId: '', name: 'Pair Test' })).toBeNull();
    expect(peerProfileRoute({ peerId: null, name: 'Pair Test' })).toBeNull();
    expect(peerProfileRoute({ peerId: '   ' })).toBeNull();
  });

  it('les champs facultatifs absents deviennent des chaînes vides, jamais "undefined"', () => {
    const route = peerProfileRoute({ peerId: 'peer-2', name: 'Pair 2' });
    expect(route?.params).toEqual({
      id: 'peer-2',
      name: 'Pair 2',
      username: '',
      avatar: '',
      gender: '',
    });
  });
});
