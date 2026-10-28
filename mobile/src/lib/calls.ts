/** Contrats de signalisation d'appels, alignés sur api/src/calls/calls.types.ts. */

export type CallStatus =
  | 'idle'
  | 'preparing'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'active'
  | 'reconnecting'
  | 'ended';

export type CallPeer = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
};

export type CallEndReason = 'hangup' | 'timeout' | 'disconnected' | 'error';

export type CallIncomingPayload = {
  callId: string;
  conversationId: string;
  from: CallPeer;
  /** L'appelant démarre en vidéo. */
  video: boolean;
  createdAt: string;
};

export type CallVideoTogglePayload = {
  callId: string;
  video: boolean;
};

export type CameraFacing = 'user' | 'environment';

export const CALL_TIMEOUT_MS = 30_000;
/** Filet local légèrement au-delà du timeout serveur (ack perdu). */
export const CALL_RING_GUARD_MS = CALL_TIMEOUT_MS + 2_000;
/** ICE déconnecté : on laisse une chance à la reprise avant de raccrocher. */
export const CALL_RECONNECT_GRACE_MS = 10_000;

/** Vidéo 480p / 24 i/s, plafonnée : le TURN et la 4G sont limités. */
export const CALL_VIDEO_FPS = 24;
export const CALL_VIDEO_MAX_BITRATE = 700_000;
export const CALL_VIDEO_STEP_BITRATE = 500_000;
export const CALL_VIDEO_LOW_BITRATE = 350_000;
