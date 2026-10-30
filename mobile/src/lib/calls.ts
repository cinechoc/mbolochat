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
/** Fenêtre de reconnexion d'un lien de groupe, participant par participant. */
export const CALL_LINK_RETRY_WINDOW_MS = 30_000;
/** Redémarrages ICE : attente croissante entre deux essais. */
export const CALL_ICE_RESTART_BASE_MS = 2_000;
export const CALL_ICE_RESTART_MAX_MS = 8_000;

/** Vidéo 480p / 24 i/s, plafonnée : le TURN et la 4G sont limités. */
export const CALL_VIDEO_FPS = 24;
/** Vidéo de groupe : 15 i/s suffisent et économisent la batterie. */
export const CALL_GROUP_VIDEO_FPS = 15;
export const CALL_VIDEO_MAX_BITRATE = 700_000;
export const CALL_VIDEO_STEP_BITRATE = 500_000;
export const CALL_VIDEO_LOW_BITRATE = 350_000;

/* ------------------------------ appels de groupe ------------------------------ */

/** Maillage : 8 en audio, 4 en vidéo — la limite réelle est celle du serveur. */
export const MAX_GROUP_CALL_AUDIO = 8;
export const MAX_GROUP_CALL_VIDEO = 4;
/** @deprecated limite par média, renvoyée par le serveur. */
export const MAX_GROUP_CALL_PARTICIPANTS = MAX_GROUP_CALL_AUDIO;

export type GroupCallMedia = 'AUDIO' | 'VIDEO';

export type GroupCallMember = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  muted: boolean;
  video: boolean;
};

/** Mode de l'appel : un à un, ou maillage de groupe. */
export type CallMode = 'DIRECT' | 'GROUP';

/** Un pair dans l'écran d'appel : identité, état du lien, état caméra. */
export type CallParticipant = GroupCallMember & {
  connected: boolean;
  /** Le lien audio est mauvais (mesures répétées, avec hystérésis). */
  weak?: boolean;
  /** Le lien est tombé : on retente pendant 30 s sans couper l'appel. */
  reconnecting?: boolean;
};

export type GroupCallIdentity = {
  conversationId: string;
  name: string;
  emoji: string | null;
  color: string | null;
  avatarUrl: string | null;
};

export type GroupCallAck =
  | {
      ok: true;
      callId: string;
      group: GroupCallIdentity;
      members: GroupCallMember[];
      media: GroupCallMedia;
      maxParticipants: number;
    }
  | { ok: false; error: 'invalid' | 'busy' | 'full' | 'forbidden' | 'rate' };

/** Bandeau « appel de groupe en cours » reçu par les membres non participants. */
export type GroupCallInvite = GroupCallIdentity & {
  callId: string;
  from: { id: string; displayName: string };
  members: GroupCallMember[];
  media: GroupCallMedia;
  maxParticipants: number;
};
