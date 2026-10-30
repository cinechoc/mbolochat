import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { setAudioModeAsync } from 'expo-audio';
import { MediaStream, type MediaStreamTrack } from 'react-native-webrtc';

import {
  CALL_GROUP_VIDEO_FPS,
  CALL_ICE_RESTART_BASE_MS,
  CALL_ICE_RESTART_MAX_MS,
  CALL_LINK_RETRY_WINDOW_MS,
  CALL_VIDEO_FPS,
  MAX_GROUP_CALL_AUDIO,
  CALL_RECONNECT_GRACE_MS,
  CALL_RING_GUARD_MS,
  CALL_VIDEO_LOW_BITRATE,
  CALL_VIDEO_MAX_BITRATE,
  CALL_VIDEO_STEP_BITRATE,
  type CallMode,
  type CallParticipant,
  type CallPeer,
  type CallStatus,
  type CameraFacing,
  type GroupCallAck,
  type GroupCallIdentity,
  type GroupCallInvite,
  type GroupCallMedia,
  type GroupCallMember,
} from '@/lib/calls';
import { buildIceServers, ensureIceServers, type IceServerConfig } from '@/lib/ice';
import { onConnection, connectSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-context';
import * as Haptics from 'expo-haptics';
import { setSpeakerphone, startCallAudio, stopCallAudio } from './audioRoute';
import { startIncomingRing, startOutgoingRing, stopRing } from './ringtone';
import { CallMedia, CAMERA_UNAVAILABLE_EMULATOR } from './engine/CallMedia';
import { RtcLink } from './engine/RtcLink';
import { applyVideoBitrate } from './engine/PeerStats';
import { IDLE_SPEAKING, updateSpeaking, type SpeakingState } from './engine/speaking';

type DeepLinkAction = 'accept' | 'decline';
type LinkOptions = { polite: boolean; group: boolean };

type CallContextValue = {
  status: CallStatus;
  /** Un à un : l'interlocuteur. Le groupe expose `peers`. */
  peer: CallPeer | null;
  mode: CallMode;
  group: GroupCallIdentity | null;
  /** Participants du groupe, dans leur ordre d'arrivée (jamais réordonnés). */
  peers: CallParticipant[];
  /** Flux vidéo reçus, par participant, pour les tuiles. */
  streams: Record<string, MediaStream>;
  /** Identifiants dont on reçoit du son à l'instant t. */
  speaking: string[];
  /** Invitation à un appel de groupe encore ouvert, pas encore rejointe. */
  offer: GroupCallInvite | null;
  /** Média de l'appel et plafond imposé par le serveur. */
  media: GroupCallMedia;
  maxParticipants: number;
  /** Mention brève affichée dans l'écran d'appel (« Marie a rejoint »). */
  mention: string | null;
  /** Moi, pour la tuile locale de la grille. */
  self: CallPeer | null;
  muted: boolean;
  startedAt: number | null;
  endReason: string | null;
  minimized: boolean;
  speakerOn: boolean;
  /** Une caméra a été utilisée : l'UI passe en mode appel vidéo. */
  videoCall: boolean;
  localCameraOn: boolean;
  remoteCameraOn: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  facing: CameraFacing;
  /** Bandeau « Connexion faible » après coupure automatique de la vidéo. */
  weakConnection: boolean;
  /** Type du candidat ICE retenu (host, srflx, relay) — diagnostic réseau. */
  networkPath: string | null;
  startCall: (conversationId: string, options?: { video?: boolean }) => Promise<void>;
  startGroupCall: (conversationId: string, options?: { video?: boolean }) => Promise<void>;
  joinOffer: () => Promise<void>;
  dismissOffer: () => void;
  /** Refuser : l'appel continue pour les autres. */
  declineOffer: () => void;
  /** Rappeler des membres du groupe depuis l'écran d'appel. */
  inviteMembers: (userIds: string[]) => void;
  /** Un administrateur sort quelqu'un de l'appel. */
  kickMember: (userId: string) => void;
  accept: (withVideo?: boolean) => Promise<void>;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  toggleCamera: () => Promise<void>;
  flipCamera: () => Promise<void>;
  minimize: () => void;
  restore: () => void;
  handleDeepLink: (input: { callId?: string; action?: string }) => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function useCalls(): CallContextValue {
  const value = useContext(CallContext);
  if (!value) {
    throw new Error('useCalls doit être utilisé sous CallProvider');
  }
  return value;
}

const IDLE_DELAY_MS = 1400;
const QUALITY_SAMPLE_MS = 2_000;
const SPEAKING_SAMPLE_MS = 700;
const WEAK_NOTICE_MS = 4_500;
/** En dessous de cette bande passante estimée, la vidéo n'a plus sa place. */
const WEAK_BITRATE = 200_000;
/** Au-dessus, le réseau est confortable : on ne dégrade rien. */
const COMFORTABLE_BITRATE = 400_000;
/** Niveau sonore recevable pour désigner celui qui parle. */
/** Mesures mauvaises d'affilée avant d'afficher « Réseau faible ». */
const WEAK_AFTER = 3;
/** Mesures bonnes d'affilée avant de retirer la mention. */
const HEALTHY_AFTER = 2;

/**
 * Le moteur d'appel de l'application : un à un et maillage de groupe. Un lien
 * `RtcLink` par interlocuteur — l'appel un à un n'est que le cas à un lien.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const [status, setStatus] = useState<CallStatus>('idle');
  const [mode, setMode] = useState<CallMode>('DIRECT');
  const [peer, setPeer] = useState<CallPeer | null>(null);
  const [group, setGroup] = useState<GroupCallIdentity | null>(null);
  const [peers, setPeers] = useState<CallParticipant[]>([]);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [speaking, setSpeaking] = useState<string[]>([]);
  const [offer, setOffer] = useState<GroupCallInvite | null>(null);
  const [media, setMedia] = useState<GroupCallMedia>('AUDIO');
  const [maxParticipants, setMaxParticipants] = useState<number>(MAX_GROUP_CALL_AUDIO);
  const [mention, setMention] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endReason, setEndReason] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [videoCall, setVideoCall] = useState(false);
  const [localCameraOn, setLocalCameraOn] = useState(false);
  const [remoteCameraOn, setRemoteCameraOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [facing, setFacing] = useState<CameraFacing>('user');
  const [weakConnection, setWeakConnection] = useState(false);
  const [networkPath, setNetworkPath] = useState<string | null>(null);

  const callIdRef = useRef<string | null>(null);
  const statusRef = useRef<CallStatus>('idle');
  const modeRef = useRef<CallMode>('DIRECT');
  const myIdRef = useRef<string | null>(null);
  const speakerRef = useRef(false);
  const mutedRef = useRef(false);
  const videoCallRef = useRef(false);
  const cameraOnRef = useRef(false);
  const facingRef = useRef<CameraFacing>('user');
  const bitrateRef = useRef(CALL_VIDEO_MAX_BITRATE);
  const fpsRef = useRef(CALL_VIDEO_FPS);
  /** État de qualité par pair : paliers et vidéo éventuellement coupée. */
  const qualityRef = useRef<Map<string, { bad: number; good: number; video: boolean }>>(new Map());
  /** Santé audio par pair, avec hystérésis pour éviter le clignotement. */
  const healthRef = useRef<Map<string, { weak: boolean; bad: number; good: number }>>(new Map());
  /** État de parole lissé par pair. */
  const speakingRef = useRef<Map<string, SpeakingState>>(new Map());
  /** Tentatives de reconnexion par pair, bornées à 30 s. */
  const retryRef = useRef<
    Map<string, { count: number; deadline: number; timer: ReturnType<typeof setTimeout> | null }>
  >(new Map());
  const resumeCameraRef = useRef(false);
  const iceRef = useRef<IceServerConfig[]>([]);
  const mediaRef = useRef<CallMedia | null>(null);
  const linksRef = useRef<Map<string, RtcLink>>(new Map());
  const audioBytesRef = useRef<Map<string, number>>(new Map());
  const pendingActionRef = useRef<{ callId: string; action: DeepLinkAction } | null>(null);
  const pendingVideoRef = useRef<MediaStreamTrack | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const weakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Relance d'un lien tombé : définie une fois `openLink` disponible. */
  const retryLinkRef = useRef<(peerId: string, options: LinkOptions) => void>(() => {});
  /** Miroir des participants pour les fermetures différées. */
  const peersRef = useRef<CallParticipant[]>([]);

  const getMedia = useCallback((): CallMedia => {
    if (!mediaRef.current) {
      mediaRef.current = new CallMedia();
    }
    return mediaRef.current;
  }, []);

  const setPhase = useCallback((next: CallStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const emit = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      if (!token) return;
      connectSocket(token).emit(event, payload);
    },
    [token],
  );

  /* ------------------------------- Routage audio ------------------------------- */

  const applySpeaker = useCallback((enabled: boolean) => {
    speakerRef.current = enabled;
    setSpeakerOn(enabled);
    setSpeakerphone(enabled);
  }, []);

  /** Près de l'oreille = écouteur ; éloigné = haut-parleur. Désactivé en vidéo. */
  const handleProximity = useCallback(
    (near: boolean) => {
      const current = statusRef.current as CallStatus;
      if (current === 'idle' || current === 'ended' || videoCallRef.current) {
        return;
      }
      applySpeaker(!near);
    },
    [applySpeaker],
  );

  const setVideoMode = useCallback(
    (enabled: boolean) => {
      videoCallRef.current = enabled;
      setVideoCall(enabled);
      if (enabled) {
        applySpeaker(true);
      }
    },
    [applySpeaker],
  );

  const showWeakConnection = useCallback(() => {
    setWeakConnection(true);
    if (weakTimerRef.current) clearTimeout(weakTimerRef.current);
    weakTimerRef.current = setTimeout(() => {
      weakTimerRef.current = null;
      setWeakConnection(false);
    }, WEAK_NOTICE_MS);
  }, []);

  /** Mention discrète de l'écran d'appel, effacée après un instant. */
  const say = useCallback((text: string) => {
    setMention(text);
    const timer = setTimeout(() => setMention((current) => (current === text ? null : current)), 2200);
    return () => clearTimeout(timer);
  }, []);

  const tap = useCallback((kind: 'light' | 'medium' | 'warning') => {
    if (kind === 'warning') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    void Haptics.impactAsync(
      kind === 'light' ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium,
    ).catch(() => {});
  }, []);

  const markPeer = useCallback((peerId: string, patch: Partial<CallParticipant>) => {
    setPeers((previous) => {
      const next = previous.map((entry) => (entry.id === peerId ? { ...entry, ...patch } : entry));
      peersRef.current = next;
      return next;
    });
  }, []);

  /* ------------------------------ Liens et média ------------------------------ */

  /** Publie le micro déjà acquis sur un lien ouvert en cours d'appel. */
  const publishMicroTo = useCallback(
    (link: RtcLink) => {
      const stream = getMedia().micStream;
      if (!stream) {
        return;
      }
      stream.getAudioTracks().forEach((track) => link.publish(track, stream));
    },
    [getMedia],
  );

  /** Acquitte le micro et le publie sur tous les liens ouverts. */
  const publishMicro = useCallback(async () => {
    const media = getMedia();
    const stream = await media.ensureMicrophone();
    stream.getAudioTracks().forEach((track) => {
      linksRef.current.forEach((link) => link.publish(track, stream));
    });
  }, [getMedia]);

  /** La caméra est une seule piste, remplacée sur chaque lien, puis renégociée. */
  const attachVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const attached = track ? new MediaStream([track]) : null;
    for (const link of linksRef.current.values()) {
      await link.setVideoTrack(track, attached);
      const sender = link.videoSenderRef;
      if (sender) {
        await applyVideoBitrate(sender, bitrateRef.current, fpsRef.current);
      }
      link.renegotiate();
    }
  }, []);

  const enableCamera = useCallback(
    async (options?: { notify?: boolean }): Promise<boolean> => {
      if (cameraOnRef.current) return true;
      const media = getMedia();
      if (CAMERA_UNAVAILABLE_EMULATOR) {
        media.showCameraEmulator();
        return false;
      }
      const allowed = await media.askCamera();
      if (!allowed) {
        media.showCameraDenied();
        return false;
      }
      let track: MediaStreamTrack;
      const fps = modeRef.current === 'GROUP' ? CALL_GROUP_VIDEO_FPS : CALL_VIDEO_FPS;
      fpsRef.current = fps;
      try {
        track = await media.openCameraTrack(fps);
      } catch {
        Alert.alert('Caméra indisponible', 'Impossible d’ouvrir la caméra. L’appel continue en vocal.');
        return false;
      }
      cameraOnRef.current = true;
      facingRef.current = media.cameraFacing;
      setFacing(media.cameraFacing);
      setLocalCameraOn(true);
      setLocalStream(new MediaStream([track]));
      setVideoMode(true);
      try {
        await attachVideoTrack(track);
      } catch {
        /* la piste sera reprise à la prochaine négociation */
      }
      if (options?.notify !== false && callIdRef.current) {
        if (modeRef.current === 'DIRECT') {
          emit('call:video-toggle', { callId: callIdRef.current, video: true });
        } else {
          emit('gcall:video', { callId: callIdRef.current, video: true });
        }
      }
      return true;
    },
    [attachVideoTrack, emit, getMedia, setVideoMode],
  );

  /** Coupe vraiment la capture (batterie/données) et prévient l'autre. */
  const disableCamera = useCallback(
    async (notify = true) => {
      const media = getMedia();
      media.stopCameraTrack();
      cameraOnRef.current = false;
      setLocalCameraOn(false);
      setLocalStream(null);
      try {
        await attachVideoTrack(null);
      } catch {
        /* piste déjà retirée */
      }
      if (notify && callIdRef.current) {
        if (modeRef.current === 'DIRECT') {
          emit('call:video-toggle', { callId: callIdRef.current, video: false });
        } else {
          emit('gcall:video', { callId: callIdRef.current, video: false });
        }
      }
    },
    [attachVideoTrack, emit, getMedia],
  );

  /* --------------------------------- Qualité --------------------------------- */

  const stopQualityMonitor = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
  }, []);

  /**
   * La vidéo cède par paliers avant l'audio : le lien le plus faible impose le
   * débit à tous, puis la caméra se coupe au plancher.
   */
  /**
   * Qualité réglée lien par lien : un pair en mauvaise réception ne coûte pas
   * la vidéo aux autres. Chaque sender descend ses paliers, puis coupe sa vidéo
   * au profit de l'audio quand son propre lien est trop juste.
   */
  const sampleQuality = useCallback(async () => {
    const cameraTrack = getMedia().cameraTrack;
    for (const [peerId, link] of linksRef.current) {
      if (link.connectionState !== 'connected') {
        continue;
      }
      const stats = await link.readStats();
      // Santé audio : trois mesures mauvaises d'affilée pour prévenir, deux
      // bonnes pour retirer la mention — jamais au moindre incident.
      const health = healthRef.current.get(peerId) ?? { weak: false, bad: 0, good: 0 };
      if (stats.quality === 'weak') {
        health.bad = Math.min(health.bad + 1, WEAK_AFTER);
        health.good = 0;
      } else if (stats.quality === 'good') {
        health.good = Math.min(health.good + 1, HEALTHY_AFTER);
        health.bad = 0;
      }
      if (!health.weak && health.bad >= WEAK_AFTER) {
        health.weak = true;
        markPeer(peerId, { weak: true });
      } else if (health.weak && health.good >= HEALTHY_AFTER) {
        health.weak = false;
        markPeer(peerId, { weak: false });
      }
      healthRef.current.set(peerId, health);

      const state = qualityRef.current.get(peerId) ?? { bad: 0, good: 0, video: true };
      const available = stats.availableBitrate;
      if (__DEV__ && cameraTrack && stats.videoBytesSent) {
        console.log(
          `[call] ${peerId} vidéo ${Math.round(stats.videoBytesSent / 1024)} Ko, dispo ${available ?? '?'} bps`,
        );
      }
      if (!available || available <= 0) {
        state.bad = 0;
        qualityRef.current.set(peerId, state);
        continue;
      }
      if (available >= COMFORTABLE_BITRATE) {
        state.bad = 0;
        state.good += 1;
        if (!state.video && state.good >= 2 && cameraOnRef.current && cameraTrack) {
          // Le lien s'est rétabli : la vidéo revient sur ce pair uniquement.
          await link.setVideoTrack(cameraTrack, new MediaStream([cameraTrack]));
          link.renegotiate();
          state.video = true;
          state.good = 0;
        }
        qualityRef.current.set(peerId, state);
        continue;
      }
      state.good = 0;
      state.bad += 1;
      if (state.bad < 2) {
        qualityRef.current.set(peerId, state);
        continue;
      }
      state.bad = 0;
      if (available < WEAK_BITRATE) {
        if (state.video) {
          await link.setVideoTrack(null, null);
          link.renegotiate();
          state.video = false;
        }
        showWeakConnection();
      } else {
        const tier = Math.max(
          CALL_VIDEO_LOW_BITRATE,
          Math.min(CALL_VIDEO_STEP_BITRATE, Math.floor(available * 0.6)),
        );
        const sender = link.videoSenderRef;
        if (sender) {
          await applyVideoBitrate(sender, tier, fpsRef.current);
        }
      }
      qualityRef.current.set(peerId, state);
    }
  }, [getMedia, markPeer, showWeakConnection]);

  const startQualityMonitor = useCallback(() => {
    stopQualityMonitor();
    statsTimerRef.current = setInterval(() => {
      void sampleQuality();
    }, QUALITY_SAMPLE_MS);
  }, [sampleQuality, stopQualityMonitor]);

  /* ------------------------------ Qui parle ------------------------------- */

  const stopSpeakingMonitor = useCallback(() => {
    if (speakingTimerRef.current) {
      clearInterval(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    setSpeaking([]);
  }, []);

  /** Le niveau des flux reçus désigne le locuteur, sans jamais réordonner les tuiles. */
  const sampleSpeaking = useCallback(async () => {
    if (linksRef.current.size === 0) {
      return;
    }
    const active: string[] = [];
    for (const [peerId, link] of linksRef.current) {
      if (link.connectionState !== 'connected') {
        continue;
      }
      const stats = await link.readStats();
      const previous = audioBytesRef.current.get(peerId) ?? 0;
      const flowing = stats.audioBytesReceived > previous;
      audioBytesRef.current.set(peerId, stats.audioBytesReceived);
      // Silence réel (pas d'octets) = niveau nul : l'anneau retombe vite.
      const level = flowing ? stats.audioLevel : 0;
      const state = updateSpeaking(speakingRef.current.get(peerId) ?? IDLE_SPEAKING, level);
      speakingRef.current.set(peerId, state);
      if (state.speaking) {
        active.push(peerId);
      }
    }
    setSpeaking((current) =>
      current.length === active.length && current.every((id, index) => id === active[index])
        ? current
        : active,
    );
  }, []);

  const startSpeakingMonitor = useCallback(() => {
    stopSpeakingMonitor();
    speakingTimerRef.current = setInterval(() => {
      void sampleSpeaking();
    }, SPEAKING_SAMPLE_MS);
  }, [sampleSpeaking, stopSpeakingMonitor]);

  /* --------------------------- Fin d'appel et reconnexion --------------------------- */

  const closeLink = useCallback((peerId: string) => {
    const link = linksRef.current.get(peerId);
    linksRef.current.delete(peerId);
    audioBytesRef.current.delete(peerId);
    try {
      link?.close();
    } catch {
      /* déjà fermé */
    }
  }, []);

  const closeAllLinks = useCallback(() => {
    for (const peerId of [...linksRef.current.keys()]) {
      closeLink(peerId);
    }
  }, [closeLink]);

  const closePeer = useCallback(() => {
    closeAllLinks();
    stopQualityMonitor();
    stopSpeakingMonitor();
    const media = mediaRef.current;
    mediaRef.current = null;
    void media?.release();
    stopCallAudio();
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, [closeAllLinks, stopQualityMonitor, stopSpeakingMonitor]);

  /** Fin d'appel locale : ferme le média et affiche l'état final brièvement. */
  const finish = useCallback(
    (reason: string) => {
      if (ringGuardRef.current) {
        clearTimeout(ringGuardRef.current);
        ringGuardRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (weakTimerRef.current) {
        clearTimeout(weakTimerRef.current);
        weakTimerRef.current = null;
      }
      stopRing();
      closePeer();
      callIdRef.current = null;
      pendingVideoRef.current = null;
      speakerRef.current = false;
      mutedRef.current = false;
      videoCallRef.current = false;
      cameraOnRef.current = false;
      facingRef.current = 'user';
      resumeCameraRef.current = false;
      bitrateRef.current = CALL_VIDEO_MAX_BITRATE;
      qualityRef.current.clear();
      healthRef.current.clear();
      speakingRef.current.clear();
      for (const attempt of retryRef.current.values()) {
        if (attempt.timer) clearTimeout(attempt.timer);
      }
      retryRef.current.clear();
      setSpeakerOn(false);
      setMuted(false);
      setStartedAt(null);
      setMinimized(false);
      setVideoCall(false);
      setLocalCameraOn(false);
      setRemoteCameraOn(false);
      setLocalStream(null);
      setRemoteStream(null);
      setStreams({});
      setFacing('user');
      setWeakConnection(false);
      setNetworkPath(null);
      setMode('DIRECT');
      modeRef.current = 'DIRECT';
      setGroup(null);
      setPeers([]);
      setSpeaking([]);
      setEndReason(reason);
      setPhase('ended');
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        setPeer(null);
        setEndReason(null);
        setPhase('idle');
      }, IDLE_DELAY_MS);
    },
    [closePeer, setPhase],
  );

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (statusRef.current === 'reconnecting') {
      setPhase('active');
    }
  }, [setPhase]);

  /**
   * Un lien perdu ne coupe pas l'appel des autres : on ne raccroche que si
   * aucun autre lien n'est en cause.
   */
  const beginReconnect = useCallback(() => {
    if (statusRef.current !== 'active' && statusRef.current !== 'connecting') {
      return;
    }
    if (modeRef.current === 'GROUP' && linksRef.current.size > 1) {
      return;
    }
    setPhase('reconnecting');
    if (reconnectTimerRef.current) {
      return;
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (callIdRef.current) {
        emit(modeRef.current === 'GROUP' ? 'gcall:leave' : 'call:end', {
          callId: callIdRef.current,
        });
      }
      finish('Connexion perdue');
    }, CALL_RECONNECT_GRACE_MS);
  }, [emit, finish, setPhase]);

  /* ---------------------------------- Liens ---------------------------------- */

  const openLink = useCallback(
    (peerId: string, options: LinkOptions) => {
      const existing = linksRef.current.get(peerId);
      if (existing) {
        return existing;
      }
      if (iceRef.current.length === 0) {
        iceRef.current = buildIceServers();
      }
      const link = new RtcLink(peerId, {
        iceServers: iceRef.current,
        polite: options.polite,
        send: (event, payload) => {
          const callId = callIdRef.current;
          if (!callId) {
            return;
          }
          emit(
            options.group ? `gcall:${event}` : `call:${event}`,
            options.group ? { callId, to: peerId, ...payload } : { callId, ...payload },
          );
        },
      });
      link.onRemoteTrack((track, stream) => {
        if (track.kind !== 'video') {
          return;
        }
        setVideoMode(true);
        if (options.group) {
          setStreams((previous) => ({ ...previous, [peerId]: stream }));
          markPeer(peerId, { video: true });
          return;
        }
        setRemoteStream(stream);
        setRemoteCameraOn(true);
      });
      link.onStateChange((state) => {
        if (state === 'connected') {
          const pending = retryRef.current.get(peerId);
          if (pending?.timer) {
            clearTimeout(pending.timer);
          }
          retryRef.current.delete(peerId);
          markPeer(peerId, { connected: true, reconnecting: false });
          if (statusRef.current === 'reconnecting') {
            clearReconnect();
          }
          if (statusRef.current === 'connecting') {
            setStartedAt(Date.now());
            setPhase('active');
          } else if (statusRef.current === 'reconnecting') {
            clearReconnect();
          }
          const sender = link.videoSenderRef;
          if (sender) {
            void applyVideoBitrate(sender, bitrateRef.current, fpsRef.current);
          }
          void link.readStats().then((stats) => {
            if (stats.candidateType) {
              setNetworkPath(stats.candidateType);
              if (__DEV__) {
                console.log(`[call] candidat ICE: ${stats.candidateType}`);
              }
            }
          });
          startQualityMonitor();
        } else if (state === 'disconnected' || state === 'failed') {
          markPeer(peerId, { connected: false, reconnecting: true });
          setPhase(statusRef.current === 'active' ? 'reconnecting' : statusRef.current);
          // Redémarrage ICE à attente croissante : on garde le média et la
          // piste micro, seule la connectivité est renégociée.
          retryLinkRef.current(peerId, options);
        }
      });
      linksRef.current.set(peerId, link);
      return link;
    },
    [clearReconnect, emit, markPeer, setPhase, setVideoMode, startQualityMonitor],
  );

  /** Ferme un lien tombé et le rouvre : l'autre côté n'a rien à faire. */
  useEffect(() => {
    retryLinkRef.current = (peerId, options) => {
      if (statusRef.current === 'idle' || statusRef.current === 'ended') {
        return;
      }
      const state = retryRef.current.get(peerId) ?? {
        count: 0,
        deadline: Date.now() + CALL_LINK_RETRY_WINDOW_MS,
        timer: null,
      };
      const giveUp = () => {
        retryRef.current.delete(peerId);
        if (options.group) {
          markPeer(peerId, { connected: false, reconnecting: false });
          closeLink(peerId);
          return;
        }
        if (callIdRef.current) {
          emit('call:end', { callId: callIdRef.current });
        }
        finish('Connexion perdue');
      };
      if (Date.now() > state.deadline) {
        giveUp();
        return;
      }
      if (state.timer) {
        return;
      }
      const delay = Math.min(
        CALL_ICE_RESTART_BASE_MS * 2 ** state.count,
        CALL_ICE_RESTART_MAX_MS,
      );
      state.timer = setTimeout(() => {
        state.timer = null;
        const link = linksRef.current.get(peerId);
        if (!link) {
          retryRef.current.delete(peerId);
          return;
        }
        if (link.connectionState === 'connected') {
          retryRef.current.delete(peerId);
          return;
        }
        state.count += 1;
        link.restartIce();
        retryRef.current.set(peerId, state);
        if (Date.now() + delay < state.deadline) {
          retryLinkRef.current(peerId, options);
        } else {
          giveUp();
        }
      }, delay);
      retryRef.current.set(peerId, state);
    };
  }, [closeLink, emit, finish, markPeer]);

  /* ------------------------------- Cycle un à un ------------------------------- */

  const startCall = useCallback(
    async (conversationId: string, options?: { video?: boolean }) => {
      if (statusRef.current !== 'idle' || !token) {
        return;
      }
      const media = getMedia();
      modeRef.current = 'DIRECT';
      setMode('DIRECT');
      setPhase('preparing');
      const micAllowed = await media.askMicrophone();
      if ((statusRef.current as CallStatus) !== 'preparing') {
        return;
      }
      if (!micAllowed) {
        setPhase('idle');
        media.showMicrophoneDenied();
        return;
      }

      let wantVideo = options?.video === true;
      let cameraTrack: MediaStreamTrack | null = null;
      if (wantVideo && CAMERA_UNAVAILABLE_EMULATOR) {
        media.showCameraEmulator();
        wantVideo = false;
      }
      if (wantVideo) {
        const cameraAllowed = await media.askCamera();
        if (!cameraAllowed) {
          media.showCameraDenied();
          wantVideo = false;
        } else {
          try {
            cameraTrack = await media.openCameraTrack();
          } catch {
            Alert.alert('Caméra indisponible', 'L’appel démarre en vocal.');
            wantVideo = false;
          }
        }
      }
      if ((statusRef.current as CallStatus) !== 'preparing') {
        media.stopCameraTrack();
        return;
      }

      setEndReason(null);
      setMinimized(false);
      setVideoMode(wantVideo);
      applySpeaker(wantVideo);
      if (cameraTrack) {
        cameraOnRef.current = true;
        facingRef.current = media.cameraFacing;
        setFacing(media.cameraFacing);
        setLocalCameraOn(true);
        setLocalStream(new MediaStream([cameraTrack]));
      }
      setPhase('outgoing');
      startOutgoingRing();
      // Filet de sécurité : ack perdu ou serveur injoignable.
      if (ringGuardRef.current) clearTimeout(ringGuardRef.current);
      ringGuardRef.current = setTimeout(() => {
        ringGuardRef.current = null;
        if (statusRef.current === 'outgoing') finish('Pas de réponse');
      }, CALL_RING_GUARD_MS);
      connectSocket(token).emit(
        'call:invite',
        { conversationId, video: wantVideo },
        (ack: { ok: boolean; callId?: string; peer?: CallPeer; error?: string }) => {
          if (!ack?.ok || !ack.callId) {
            stopRing();
            finish(
              ack?.error === 'busy'
                ? 'Contact occupé'
                : ack?.error === 'unavailable'
                  ? 'Appel indisponible'
                  : 'Appel impossible',
            );
            return;
          }
          callIdRef.current = ack.callId;
          setPeer(ack.peer ?? null);
          if (ack.peer) {
            // Le lien est prêt à répondre ; micro et caméra ne partent qu'au décroché.
            openLink(ack.peer.id, { polite: false, group: false });
            pendingVideoRef.current = cameraTrack;
          }
        },
      );
    },
    [applySpeaker, finish, getMedia, openLink, setPhase, setVideoMode, token],
  );

  const accept = useCallback(
    async (withVideo = false) => {
      const callId = callIdRef.current;
      const peerId = peer?.id;
      if (!callId || !peerId || statusRef.current !== 'incoming') return;
      setPhase('connecting');
      stopRing();
      const media = getMedia();
      const micAllowed = await media.askMicrophone();
      // L'appel a pu être annulé pendant la demande de permission.
      if ((statusRef.current as CallStatus) !== 'connecting') {
        return;
      }
      if (!micAllowed) {
        emit('call:reject', { callId, reason: 'declined' });
        media.showMicrophoneDenied();
        finish('Micro inaccessible');
        return;
      }

      let wantedVideo = withVideo;
      let cameraTrack: MediaStreamTrack | null = null;
      if (wantedVideo && CAMERA_UNAVAILABLE_EMULATOR) {
        media.showCameraEmulator();
        wantedVideo = false;
      }
      if (wantedVideo) {
        const cameraAllowed = await media.askCamera();
        if (!cameraAllowed) {
          media.showCameraDenied();
          wantedVideo = false;
        } else {
          try {
            cameraTrack = await media.openCameraTrack();
          } catch {
            wantedVideo = false;
          }
        }
      }
      if ((statusRef.current as CallStatus) !== 'connecting') {
        media.stopCameraTrack();
        return;
      }

      if (wantedVideo) {
        setVideoMode(true);
      }
      startCallAudio(handleProximity);
      // Après `start` : c'est lui qui remet la route audio par défaut.
      applySpeaker(videoCallRef.current);
      const link = openLink(peerId, { polite: true, group: false });
      try {
        await publishMicro();
        if (cameraTrack) {
          cameraOnRef.current = true;
          facingRef.current = media.cameraFacing;
          setFacing(media.cameraFacing);
          setLocalCameraOn(true);
          setLocalStream(new MediaStream([cameraTrack]));
          await attachVideoTrack(cameraTrack);
        }
      } catch {
        emit('call:reject', { callId, reason: 'declined' });
        finish('Micro inaccessible');
        return;
      }
      link.initiate();
      emit('call:accept', { callId, video: wantedVideo });
      pendingActionRef.current = null;
    },
    [
      applySpeaker,
      attachVideoTrack,
      emit,
      finish,
      getMedia,
      handleProximity,
      openLink,
      peer?.id,
      publishMicro,
      setPhase,
      setVideoMode,
    ],
  );

  const reject = useCallback(() => {
    const callId = callIdRef.current;
    if (callId && statusRef.current === 'incoming') {
      emit('call:reject', { callId, reason: 'declined' });
    }
    finish('Appel refusé');
  }, [emit, finish]);

  const hangup = useCallback(() => {
    const callId = callIdRef.current;
    if (callId) {
      if (modeRef.current === 'GROUP') {
        emit('gcall:leave', { callId });
      } else {
        const wasRinging = statusRef.current === 'outgoing';
        emit(wasRinging ? 'call:cancel' : 'call:end', { callId });
      }
    }
    finish('Appel terminé');
  }, [emit, finish]);

  const toggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      mutedRef.current = next;
      mediaRef.current?.setMuted(next);
      if (modeRef.current === 'GROUP' && callIdRef.current) {
        emit('gcall:mute', { callId: callIdRef.current, muted: next });
      }
      tap('light');
      return next;
    });
  }, [emit, tap]);

  const toggleSpeaker = useCallback(() => {
    applySpeaker(!speakerRef.current);
  }, [applySpeaker]);

  const toggleCamera = useCallback(async () => {
    const current = statusRef.current;
    if (
      current !== 'outgoing' &&
      current !== 'connecting' &&
      current !== 'active' &&
      current !== 'reconnecting'
    ) {
      return;
    }
    const media = getMedia();
    if (media.cameraBusy) return;
    media.setCameraBusy(true);
    try {
      if (cameraOnRef.current) {
        await disableCamera(true);
      } else {
        await enableCamera();
      }
    } finally {
      media.setCameraBusy(false);
    }
  }, [disableCamera, enableCamera, getMedia]);

  /** Bascule avant/arrière via `applyConstraints` : pas de seconde session de capture. */
  const flipCamera = useCallback(async () => {
    const media = getMedia();
    if (!cameraOnRef.current || media.cameraBusy) return;
    media.setCameraBusy(true);
    try {
      const next = await media.flipCamera();
      facingRef.current = next;
      setFacing(next);
    } catch {
      Alert.alert('Caméra indisponible', 'Impossible de changer de caméra.');
    } finally {
      media.setCameraBusy(false);
    }
  }, [getMedia]);

  const minimize = useCallback(() => {
    const current = statusRef.current;
    if (
      current === 'outgoing' ||
      current === 'connecting' ||
      current === 'active' ||
      current === 'reconnecting'
    ) {
      // Réduit : la caméra s'arrête (batterie/données), l'audio continue.
      const media = getMedia();
      if (cameraOnRef.current && !media.cameraBusy) {
        resumeCameraRef.current = true;
        media.setCameraBusy(true);
        void disableCamera(true).finally(() => {
          media.setCameraBusy(false);
        });
      }
      setMinimized(true);
    }
  }, [disableCamera, getMedia]);

  const restore = useCallback(() => {
    setMinimized(false);
    const media = getMedia();
    if (!resumeCameraRef.current || media.cameraBusy) return;
    resumeCameraRef.current = false;
    const current = statusRef.current;
    if (
      current === 'outgoing' ||
      current === 'connecting' ||
      current === 'active' ||
      current === 'reconnecting'
    ) {
      media.setCameraBusy(true);
      void enableCamera().finally(() => {
        media.setCameraBusy(false);
      });
    }
  }, [enableCamera, getMedia]);

  const handleDeepLink = useCallback(
    (input: { callId?: string; action?: string }) => {
      const action = input.action === 'accept' ? 'accept' : input.action === 'decline' ? 'decline' : null;
      if (!action) return;
      const callId = input.callId ?? callIdRef.current;
      if (!callId) return;
      // L'invitation peut arriver juste après (socket en cours de connexion).
      if (statusRef.current === 'incoming' && callIdRef.current === callId) {
        if (action === 'accept') void accept(videoCallRef.current);
        else reject();
        return;
      }
      pendingActionRef.current = { callId, action };
    },
    [accept, reject],
  );

  /* ------------------------------ Cycle de groupe ------------------------------ */

  const beginGroupCall = useCallback(
    async (ack: Extract<GroupCallAck, { ok: true }>) => {
      callIdRef.current = ack.callId;
      modeRef.current = 'GROUP';
      setMode('GROUP');
      setMedia(ack.media);
      setMaxParticipants(ack.maxParticipants);
      setGroup(ack.group);
      setOffer(null);
      setMinimized(false);
      setStartedAt(Date.now());
      setPhase('connecting');
      startCallAudio();
      // Écouteur par défaut, comme en un à un : le haut-parleur reste un choix.
      applySpeaker(false);
      const others = ack.members.filter((member) => member.id !== myIdRef.current);
      setPeers(
        others.map((member: GroupCallMember) => ({ ...member, connected: false, video: false })),
      );
      // On est l'arrivant : c'est nous qui ouvrons chaque lien.
      for (const member of others) {
        openLink(member.id, { polite: (myIdRef.current ?? '') > member.id, group: true });
      }
      try {
        await publishMicro();
        const track = getMedia().cameraTrack;
        if (track) {
          await attachVideoTrack(track);
        }
      } catch {
        emit('gcall:leave', { callId: ack.callId });
        finish('Micro inaccessible');
        return;
      }
      linksRef.current.forEach((link) => link.initiate());
      startSpeakingMonitor();
      if (others.length === 0) {
        setPhase('active');
      }
    },
    [applySpeaker, attachVideoTrack, emit, finish, getMedia, openLink, publishMicro, setPhase, startSpeakingMonitor],
  );

  const startGroupCall = useCallback(
    async (conversationId: string, options?: { video?: boolean }) => {
      if (!token || statusRef.current !== 'idle') {
        return;
      }
      const media = getMedia();
      const micAllowed = await media.askMicrophone();
      if (!micAllowed) {
        media.showMicrophoneDenied();
        return;
      }
      setEndReason(null);
      setPhase('connecting');
      if (options?.video === true) {
        await enableCamera({ notify: false });
      }
      connectSocket(token).emit(
        'gcall:start',
        { conversationId, media: options?.video === true ? 'VIDEO' : 'AUDIO' },
        (ack: GroupCallAck) => {
          if (!ack?.ok) {
            finish(
              ack?.error === 'full'
                ? 'Appel complet'
                : ack?.error === 'busy'
                  ? 'Vous êtes déjà dans un appel'
                  : 'Appel de groupe impossible',
            );
            return;
          }
          void beginGroupCall(ack);
        },
      );
    },
    [beginGroupCall, enableCamera, finish, getMedia, setPhase, token],
  );

  const joinOffer = useCallback(async () => {
    const conversationId = offer?.conversationId;
    setOffer(null);
    if (conversationId) {
      await startGroupCall(conversationId);
    }
  }, [offer?.conversationId, startGroupCall]);

  const dismissOffer = useCallback(() => {
    stopRing();
    setOffer(null);
  }, []);


  /** Refuser une invitation : l'appel continue pour les autres. */
  const declineOffer = useCallback(() => {
    const callId = offer?.callId;
    stopRing();
    setOffer(null);
    if (callId) {
      emit('gcall:decline', { callId });
    }
  }, [emit, offer]);

  /** Rappeler des membres du groupe sans quitter l'écran d'appel. */
  const inviteMembers = useCallback(
    (userIds: string[]) => {
      if (callIdRef.current && userIds.length > 0) {
        emit('gcall:add', { callId: callIdRef.current, userIds });
      }
    },
    [emit],
  );

  /** Un administrateur sort quelqu'un de l'appel ; l'appel continue. */
  const kickMember = useCallback(
    (userId: string) => {
      if (callIdRef.current) {
        emit('gcall:kick', { callId: callIdRef.current, userId });
      }
    },
    [emit],
  );

  /* ------------------------- Événements de signalisation ------------------------- */

  useEffect(() => {
    myIdRef.current = user?.id ?? null;
  }, [user?.id]);

  // STUN/TURN servis par l'API : jamais d'identifiants dans le bundle.
  useEffect(() => {
    if (!token) {
      return;
    }
    let cancelled = false;
    void ensureIceServers(token).then((servers) => {
      if (!cancelled && servers.length > 0) {
        iceRef.current = servers;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const socket = connectSocket(token);

    /* ------------------------------- un à un ------------------------------- */

    const onIncoming = (payload: { callId: string; from: CallPeer; video?: boolean }) => {
      if (statusRef.current !== 'idle') {
        // Déjà en appel : le serveur gère le « busy » ; on ignore simplement.
        return;
      }
      callIdRef.current = payload.callId;
      modeRef.current = 'DIRECT';
      setMode('DIRECT');
      setPeer(payload.from);
      setEndReason(null);
      setMinimized(false);
      setRemoteCameraOn(false);
      if (payload.video === true) {
        setVideoMode(true);
      } else {
        setVideoMode(false);
        applySpeaker(false);
      }
      // Le lien est créé dès l'invitation : il attend l'offer en pair « poli ».
      openLink(payload.from.id, { polite: true, group: false });
      setPhase('incoming');
      void startIncomingRing();
      const pending = pendingActionRef.current;
      if (pending && pending.callId === payload.callId) {
        pendingActionRef.current = null;
        if (pending.action === 'accept') {
          // Laisse le temps à l'état « incoming » d'être rendu.
          setTimeout(() => void accept(payload.video === true), 120);
        } else {
          setTimeout(() => reject(), 120);
        }
      }
    };

    const onAccepted = async () => {
      if (statusRef.current !== 'outgoing') return;
      setPhase('connecting');
      stopRing();
      startCallAudio(handleProximity);
      // Après `start` : c'est lui qui remet la route audio par défaut.
      applySpeaker(videoCallRef.current);
      const pendingTrack = pendingVideoRef.current;
      pendingVideoRef.current = null;
      try {
        await publishMicro();
        if (pendingTrack) {
          await attachVideoTrack(pendingTrack);
        }
      } catch {
        emit('call:end', { callId: callIdRef.current });
        finish('Connexion impossible');
      }
    };

    const directLink = () => linksRef.current.values().next().value as RtcLink | undefined;

    const onOffer = async (payload: { callId: string; sdp: string }) => {
      if (callIdRef.current !== payload.callId) return;
      const result = await directLink()?.handleOffer(payload.sdp);
      if (result === 'failed') finish('Connexion impossible');
    };

    const onAnswer = async (payload: { callId: string; sdp: string }) => {
      if (callIdRef.current !== payload.callId) return;
      await directLink()?.handleAnswer(payload.sdp);
    };

    const onIce = async (payload: { callId: string; candidate: unknown }) => {
      if (callIdRef.current !== payload.callId) return;
      await directLink()?.handleCandidate(payload.candidate);
    };

    const onVideoToggle = (payload: { callId: string; video: boolean }) => {
      if (callIdRef.current !== payload.callId) return;
      setRemoteCameraOn(payload.video);
      if (payload.video) {
        setVideoMode(true);
      }
    };

    const onRejected = () => {
      if (statusRef.current === 'outgoing') finish('Appel refusé');
    };
    const onCancelled = () => {
      if (statusRef.current === 'incoming' || statusRef.current === 'connecting') {
        finish('Appel annulé');
      }
    };
    const onEnded = (payload: { reason: string }) => {
      if (!callIdRef.current) return;
      const reason =
        payload.reason === 'timeout'
          ? 'Pas de réponse'
          : payload.reason === 'disconnected'
            ? 'Connexion perdue'
            : 'Appel terminé';
      finish(reason);
    };
    const onMissed = () => {
      if (statusRef.current === 'incoming') finish('Appel manqué');
    };

    /* -------------------------------- groupe -------------------------------- */

    const onGroupIncoming = (payload: GroupCallInvite) => {
      if (!payload?.callId || callIdRef.current === payload.callId) return;
      setOffer(payload);
      // Seuls ceux qui ne sont pas déjà en appel entendent la sonnerie.
      if (statusRef.current === 'idle') {
        void startIncomingRing();
      }
    };

    // Occupé ailleurs : simple notification, pas de sonnerie.
    const onGroupBusy = (payload: GroupCallInvite) => {
      if (!payload?.callId || callIdRef.current === payload.callId) return;
      setOffer(payload);
    };

    const onGroupKicked = (payload: { callId: string }) => {
      if (callIdRef.current !== payload?.callId) return;
      tap('warning');
      finish('Retiré de l’appel');
    };

    const onGroupMedia = (payload: { callId: string; media: GroupCallMedia }) => {
      if (callIdRef.current !== payload?.callId) return;
      setMedia(payload.media);
    };

    const onGroupVideo = (payload: { callId: string; userId: string; video: boolean }) => {
      if (callIdRef.current !== payload?.callId) return;
      markPeer(payload.userId, { video: payload.video });
    };

    const onGroupJoined = (payload: { callId: string; peer: GroupCallMember }) => {
      if (callIdRef.current !== payload?.callId || !payload?.peer) return;
      const joined = payload.peer;
      tap('light');
      say(`${joined.displayName} a rejoint`);
      setPeers((previous) =>
        previous.some((entry) => entry.id === joined.id)
          ? previous.map((entry) => (entry.id === joined.id ? { ...entry, ...joined } : entry))
          : [...previous, { ...joined, connected: false, video: false }],
      );
      if (linksRef.current.has(joined.id)) {
        // Lien déjà ouvert : l'arrivant a négocié, on répondra sur celui-là.
        return;
      }
      const link = openLink(joined.id, {
        polite: (myIdRef.current ?? '') > joined.id,
        group: true,
      });
      publishMicroTo(link);
    };

    const onGroupOffer = async (payload: { callId: string; from: string; sdp: string }) => {
      if (callIdRef.current !== payload?.callId) return;
      const link = openLink(payload.from, {
        polite: (myIdRef.current ?? '') > payload.from,
        group: true,
      });
      publishMicroTo(link);
      await link.handleOffer(payload.sdp);
    };

    const onGroupAnswer = async (payload: { callId: string; from: string; sdp: string }) => {
      if (callIdRef.current !== payload?.callId) return;
      await linksRef.current.get(payload.from)?.handleAnswer(payload.sdp);
    };

    const onGroupIce = async (payload: { callId: string; from: string; candidate: unknown }) => {
      if (callIdRef.current !== payload?.callId) return;
      await linksRef.current.get(payload.from)?.handleCandidate(payload.candidate);
    };

    const onGroupMute = (payload: { callId: string; userId: string; muted: boolean }) => {
      if (callIdRef.current !== payload?.callId) return;
      markPeer(payload.userId, { muted: payload.muted });
    };

    const onGroupPeerLeft = (payload: { callId: string; userId: string }) => {
      if (callIdRef.current !== payload?.callId) return;
      const gone = peersRef.current.find((entry) => entry.id === payload.userId);
      if (gone) {
        say(`${gone.displayName} est parti`);
      }
      closeLink(payload.userId);
      setStreams((previous) => {
        const next = { ...previous };
        delete next[payload.userId];
        return next;
      });
      setPeers((previous) => previous.filter((entry) => entry.id !== payload.userId));
    };

    const onGroupEnded = (payload: { callId: string }) => {
      if (callIdRef.current === payload?.callId) {
        finish('Appel terminé');
        return;
      }
      if (offer?.callId === payload?.callId) {
        stopRing();
        setOffer(null);
      }
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:offer', onOffer);
    socket.on('call:answer', onAnswer);
    socket.on('call:ice', onIce);
    socket.on('call:video-toggle', onVideoToggle);
    socket.on('call:rejected', onRejected);
    socket.on('call:cancelled', onCancelled);
    socket.on('call:ended', onEnded);
    socket.on('call:missed', onMissed);
    socket.on('gcall:incoming', onGroupIncoming);
    socket.on('gcall:busy', onGroupBusy);
    socket.on('gcall:kicked', onGroupKicked);
    socket.on('gcall:media', onGroupMedia);
    socket.on('gcall:video', onGroupVideo);
    socket.on('gcall:joined', onGroupJoined);
    socket.on('gcall:offer', onGroupOffer);
    socket.on('gcall:answer', onGroupAnswer);
    socket.on('gcall:ice', onGroupIce);
    socket.on('gcall:mute', onGroupMute);
    socket.on('gcall:peer-left', onGroupPeerLeft);
    socket.on('gcall:ended', onGroupEnded);

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:offer', onOffer);
      socket.off('call:answer', onAnswer);
      socket.off('call:ice', onIce);
      socket.off('call:video-toggle', onVideoToggle);
      socket.off('call:rejected', onRejected);
      socket.off('call:cancelled', onCancelled);
      socket.off('call:ended', onEnded);
      socket.off('call:missed', onMissed);
      socket.off('gcall:incoming', onGroupIncoming);
      socket.off('gcall:busy', onGroupBusy);
      socket.off('gcall:kicked', onGroupKicked);
      socket.off('gcall:media', onGroupMedia);
      socket.off('gcall:video', onGroupVideo);
      socket.off('gcall:joined', onGroupJoined);
      socket.off('gcall:offer', onGroupOffer);
      socket.off('gcall:answer', onGroupAnswer);
      socket.off('gcall:ice', onGroupIce);
      socket.off('gcall:mute', onGroupMute);
      socket.off('gcall:peer-left', onGroupPeerLeft);
      socket.off('gcall:ended', onGroupEnded);
    };
  }, [
    accept,
    applySpeaker,
    attachVideoTrack,
    closeLink,
    emit,
    finish,
    handleProximity,
    markPeer,
    offer?.callId,
    openLink,
    publishMicro,
    publishMicroTo,
    reject,
    say,
    setPhase,
    setVideoMode,
    tap,
    token,
  ]);

  // Socket coupé pendant un appel : « Reconnexion… » puis fin après la grâce.
  useEffect(() => {
    const off = onConnection((connected) => {
      if (!connected) {
        if (statusRef.current === 'active' || statusRef.current === 'connecting') {
          beginReconnect();
        }
        return;
      }
      const anyLive = [...linksRef.current.values()].some((l) => l.connectionState === 'connected');
      if (statusRef.current === 'reconnecting' && anyLive) {
        clearReconnect();
      }
    });
    return () => {
      off();
    };
  }, [beginReconnect, clearReconnect]);

  useEffect(() => {
    return () => {
      stopRing();
      closePeer();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (weakTimerRef.current) clearTimeout(weakTimerRef.current);
    };
  }, [closePeer]);

  const value: CallContextValue = {
    status,
    peer,
    mode,
    group,
    peers,
    streams,
    speaking,
    offer,
    media,
    maxParticipants,
    mention,
    muted,
    startedAt,
    endReason,
    minimized,
    speakerOn,
    videoCall,
    localCameraOn,
    remoteCameraOn,
    localStream,
    remoteStream,
    facing,
    weakConnection,
    networkPath,
    startCall,
    startGroupCall,
    joinOffer,
    dismissOffer,
    declineOffer,
    inviteMembers,
    kickMember,
    self: user ? { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null } : null,
    accept,
    reject,
    hangup,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
    flipCamera,
    minimize,
    restore,
    handleDeepLink,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}
