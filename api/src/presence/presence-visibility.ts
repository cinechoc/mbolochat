import type {
  PresencePermissions,
  PresenceRelation,
  PresenceUser,
} from './presence.types.js';

/**
 * Seule autorité de visibilité de la présence. Le serveur ne doit jamais
 * retourner au client un champ que cette fonction n'autorise pas.
 *
 * - soi-même : tout est visible ;
 * - blocage dans un sens ou l'autre : rien ;
 * - « contacts » se lit sur la cible : le lien est une conversation partagée ;
 * - la réciprocité ne masque que la dernière connexion, jamais l'état « en ligne »
 *   (qui reste soumis à la visibilité choisie par la cible).
 */
export function canSeePresence(
  viewer: PresenceUser,
  target: PresenceUser,
  relation: PresenceRelation,
): PresencePermissions {
  if (viewer.id === target.id) {
    return { canSeeOnline: true, canSeeLastSeen: true };
  }
  if (relation.blocked) {
    return { canSeeOnline: false, canSeeLastSeen: false };
  }

  const targetAllowsLastSeen =
    target.lastSeenVisibility === 'everyone' ||
    (target.lastSeenVisibility === 'contacts' && relation.isContact);

  const canSeeLastSeen =
    targetAllowsLastSeen && viewer.lastSeenVisibility !== 'nobody';

  const canSeeOnline =
    target.onlineVisibility === 'everyone' ||
    (target.onlineVisibility === 'same_as_last_seen' && targetAllowsLastSeen);

  return { canSeeOnline, canSeeLastSeen };
}
