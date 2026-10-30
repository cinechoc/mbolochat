/** Types partagés de la signalisation d'appels (miroir côté mobile). */

export type CallRejectReason = 'declined' | 'busy';
export type CallEndReason = 'hangup' | 'timeout' | 'disconnected' | 'error';

/** Issue finale, résumée dans le message système de la conversation. */
export type CallOutcome = 'completed' | 'declined' | 'missed' | 'cancelled' | 'failed';

export interface CallPeer {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CallIncomingPayload {
  callId: string;
  conversationId: string;
  from: CallPeer;
  /** L'appelant démarre en vidéo : l'écran entrant l'annonce. */
  video: boolean;
  createdAt: string;
}

/** Caméra locale activée ou coupée pendant un appel. */
export interface CallVideoTogglePayload {
  callId: string;
  video: boolean;
}

export interface CallEndedPayload {
  callId: string;
  reason: CallEndReason;
  durationMs: number;
  outcome: CallOutcome;
}

export type CallInviteError = 'invalid' | 'busy' | 'unavailable' | 'rate';

export type CallInviteAck =
  | { ok: true; callId: string; peer: CallPeer }
  | { ok: false; error: CallInviteError };

export interface CallSdpPayload {
  callId: string;
  sdp: string;
  type: 'offer' | 'answer';
}

export interface CallIcePayload {
  callId: string;
  candidate: unknown;
}

/* ------------------------------ appels de groupe ------------------------------ */

/** Maillage WebRTC : chaque participant envoie son flux à tous les autres. */
export type GroupCallMedia = 'AUDIO' | 'VIDEO';

export interface GroupCallMember {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  muted: boolean;
  /** Ce participant a la caméra allumée. */
  video: boolean;
}

export interface GroupCallIdentity {
  conversationId: string;
  name: string;
  emoji: string | null;
  color: string | null;
  avatarUrl: string | null;
}

export type GroupCallError = 'invalid' | 'busy' | 'full' | 'forbidden' | 'rate';

export type GroupCallAck =
  | {
      ok: true;
      callId: string;
      group: GroupCallIdentity;
      members: GroupCallMember[];
      media: GroupCallMedia;
      maxParticipants: number;
    }
  | { ok: false; error: GroupCallError };

/** Invitation reçue par les membres du groupe : bandeau « Rejoindre ». */
export interface GroupCallInvitePayload extends GroupCallIdentity {
  callId: string;
  from: { id: string; displayName: string };
  members: GroupCallMember[];
  media: GroupCallMedia;
  maxParticipants: number;
}

/** Signalisation maillée : `to` cible un participant, `from` désigne l'émetteur. */
export interface GroupCallSignalPayload {
  callId: string;
  to?: string;
  sdp?: string;
  candidate?: unknown;
}

export interface GroupCallEndedPayload {
  callId: string;
  conversationId: string;
}
