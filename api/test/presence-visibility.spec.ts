import { describe, expect, it } from 'vitest';
import { canSeePresence } from '../src/presence/presence-visibility.js';
import type {
  LastSeenVisibility,
  OnlineVisibility,
  PresenceRelation,
  PresenceUser,
} from '../src/presence/presence.types.js';

const user = (
  id: string,
  lastSeenVisibility: LastSeenVisibility,
  onlineVisibility: OnlineVisibility,
): PresenceUser => ({ id, lastSeenVisibility, onlineVisibility });

const relation = (isContact: boolean, blocked = false): PresenceRelation => ({
  isContact,
  blocked,
});

const viewer = user('viewer', 'contacts', 'same_as_last_seen');

describe('canSeePresence', () => {
  const cases: Array<{
    name: string;
    viewer: PresenceUser;
    target: PresenceUser;
    relation: PresenceRelation;
    online: boolean;
    lastSeen: boolean;
  }> = [
    {
      name: 'soi-même, tout est visible même avec Personne',
      viewer: user('me', 'nobody', 'same_as_last_seen'),
      target: user('me', 'nobody', 'same_as_last_seen'),
      relation: relation(false),
      online: true,
      lastSeen: true,
    },
    {
      name: 'blocage : rien',
      viewer,
      target: user('target', 'everyone', 'everyone'),
      relation: relation(true, true),
      online: false,
      lastSeen: false,
    },
    {
      name: 'dernière connexion Tout le monde + en ligne Tout le monde',
      viewer,
      target: user('target', 'everyone', 'everyone'),
      relation: relation(false),
      online: true,
      lastSeen: true,
    },
    {
      name: 'contacts et contact : tout visible',
      viewer,
      target: user('target', 'contacts', 'same_as_last_seen'),
      relation: relation(true),
      online: true,
      lastSeen: true,
    },
    {
      name: 'contacts sans contact : rien',
      viewer,
      target: user('target', 'contacts', 'same_as_last_seen'),
      relation: relation(false),
      online: false,
      lastSeen: false,
    },
    {
      name: 'dernière connexion Personne, en ligne Tout le monde',
      viewer,
      target: user('target', 'nobody', 'everyone'),
      relation: relation(true),
      online: true,
      lastSeen: false,
    },
    {
      name: 'dernière connexion Personne, en ligne Comme la dernière connexion',
      viewer,
      target: user('target', 'nobody', 'same_as_last_seen'),
      relation: relation(true),
      online: false,
      lastSeen: false,
    },
    {
      name: 'réciprocité Personne : dernière connexion masquée, en ligne Tout le monde reste visible',
      viewer: user('viewer', 'nobody', 'same_as_last_seen'),
      target: user('target', 'everyone', 'everyone'),
      relation: relation(true),
      online: true,
      lastSeen: false,
    },
    {
      name: 'réciprocité Personne : en ligne Comme la dernière connexion reste visible si la cible autorise',
      viewer: user('viewer', 'nobody', 'same_as_last_seen'),
      target: user('target', 'contacts', 'same_as_last_seen'),
      relation: relation(true),
      online: true,
      lastSeen: false,
    },
    {
      name: 'réciprocité Personne sans contact : rien',
      viewer: user('viewer', 'nobody', 'same_as_last_seen'),
      target: user('target', 'contacts', 'same_as_last_seen'),
      relation: relation(false),
      online: false,
      lastSeen: false,
    },
    {
      name: 'le réglage contacts du demandeur ne limite pas ce qu’il voit',
      viewer: user('viewer', 'contacts', 'same_as_last_seen'),
      target: user('target', 'everyone', 'everyone'),
      relation: relation(false),
      online: true,
      lastSeen: true,
    },
    {
      name: 'blocage réciproque avec réglages permissifs : rien',
      viewer: user('viewer', 'everyone', 'everyone'),
      target: user('target', 'everyone', 'everyone'),
      relation: relation(false, true),
      online: false,
      lastSeen: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(canSeePresence(testCase.viewer, testCase.target, testCase.relation)).toEqual({
        canSeeOnline: testCase.online,
        canSeeLastSeen: testCase.lastSeen,
      });
    });
  }
});
