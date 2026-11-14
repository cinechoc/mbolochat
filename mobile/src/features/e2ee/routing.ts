import type { ConversationSummary, Gender } from '@/lib/types';

/**
 * Choix de la route d'une conversation.
 *
 * La source de vérité est **le serveur** : `conversation.e2eeSince`, renvoyé par
 * `GET /conversations` et `GET /conversations/:id`. Aucune déduction sur le nom,
 * l'apparence ou la présence d'un cadenas dans l'interface. Une conversation
 * chiffrée n'a **jamais** de repli vers l'écran en clair : si l'identité du
 * correspondant manque, on refuse la navigation au lieu de laisser l'écran
 * classique tenter un envoi que le serveur refusera (anti-downgrade).
 */
export type ChatRoute =
  | { kind: 'classic'; pathname: '/chat/[id]'; params: { id: string } }
  | { kind: 'blocked'; reason: 'peer_missing' };

/** Correspondant d'une discussion directe, tel que le serveur le décrit. */
export function directPeerOf(
  conversation: ConversationSummary,
  currentUserId: string | null | undefined,
): {
  id: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  gender: Gender | null;
} | null {
  if (conversation.type !== 'DIRECT') return null;
  const members = (conversation.members ?? []).filter((member) => Boolean(member?.id));
  // On ne retient que les membres qui ne sont pas l'utilisateur courant. Sans
  // identité courante connue, seule une liste d'exactement un membre est
  // interprétable : au-delà, on refuse plutôt que de choisir au hasard.
  const others = currentUserId ? members.filter((member) => member.id !== currentUserId) : members;
  const peer = others.length === 1 ? others[0] : undefined;
  if (!peer?.id) return null;
  const name = (peer.displayName || peer.username || conversation.name || '').trim();
  return {
    id: peer.id,
    name,
    username: peer.username ?? null,
    avatarUrl: peer.avatarUrl ?? null,
    gender: peer.gender ?? null,
  };
}

export function chatRouteFor(input: {
  conversation: Pick<ConversationSummary, 'id' | 'type' | 'name' | 'e2eeSince' | 'members'>;
  currentUserId?: string | null;
  e2eeEnabled: boolean;
}): ChatRoute {
  const { conversation, currentUserId, e2eeEnabled } = input;
  if (!e2eeEnabled || !conversation.e2eeSince) {
    return { kind: 'classic', pathname: '/chat/[id]', params: { id: conversation.id } };
  }
  const peer = directPeerOf(conversation as ConversationSummary, currentUserId);
  if (!peer) return { kind: 'blocked', reason: 'peer_missing' };
  // L’écran unifié résout lui-même le transport chiffré : une seule route,
  // aucun retour possible vers un écran clair.
  return { kind: 'classic', pathname: '/chat/[id]', params: { id: conversation.id } };
}

/**
 * Route du profil du correspondant, ouverte depuis le nom dans l'en-tête.
 *
 * L'identifiant est **toujours** l'identifiant utilisateur (`peerId`) : le nom
 * affiché n'est jamais utilisé comme clé, il ne sert qu'à l'affichage et à
 * l'avatar. Sans identifiant, la fonction renvoie `null` et l'écran n'ouvre
 * aucun profil plutôt que d'en deviner un.
 */
export function peerProfileRoute(input: {
  peerId?: string | null;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  gender?: string | null;
}): {
  pathname: '/user/[id]';
  params: { id: string; name: string; username: string; avatar: string; gender: string };
} | null {
  const peerId = (input.peerId ?? '').trim();
  if (!peerId) return null;
  return {
    pathname: '/user/[id]',
    params: {
      id: peerId,
      name: (input.name ?? '').trim(),
      username: (input.username ?? '').trim(),
      avatar: (input.avatarUrl ?? '').trim(),
      gender: (input.gender ?? '').trim(),
    },
  };
}
