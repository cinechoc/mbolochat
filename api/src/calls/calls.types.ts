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
