import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Linking } from 'react-native';
import { Camera } from 'expo-camera';
import * as Device from 'expo-device';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import {
  MediaStream,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  type MediaStreamTrack,
  type RTCRtpSender,
} from 'react-native-webrtc';

import {
  CALL_RECONNECT_GRACE_MS,
  CALL_RING_GUARD_MS,
  CALL_VIDEO_FPS,
  CALL_VIDEO_LOW_BITRATE,
  CALL_VIDEO_MAX_BITRATE,
  CALL_VIDEO_STEP_BITRATE,
  type CallPeer,
  type CallStatus,
  type CameraFacing,
} from '@/lib/calls';
import { buildIceServers } from '@/lib/ice';
import { onConnection, connectSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-context';
import { setSpeakerphone, startCallAudio, stopCallAudio } from './audioRoute';
import { startIncomingRing, startOutgoingRing, stopRing } from './ringtone';

type DeepLinkAction = 'accept' | 'decline';

type CallContextValue = {
  status: CallStatus;
  peer: CallPeer | null;
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
const QUALITY_SAMPLE_MS = 4_000;
const WEAK_NOTICE_MS = 4_500;
/**
 * La caméra virtuelle de Waydroid ne délivre aucune image (0 fps) et fait
 * planter le thread natif de libwebrtc (« updateTexImage »). En développement,
 * on évite donc la capture sur cet émulateur : l'appel reste vocal. Les
 * téléphones réels ne sont pas concernés.
 */
const CAMERA_UNAVAILABLE_EMULATOR =
  __DEV__ && (Device.osBuildFingerprint ?? '').toLowerCase().includes('waydroid');

/**
 * Appels vocaux et vidéo 1:1 : signalisation Socket.IO, média WebRTC,
 * négociation parfaite (bascule vocal ↔ vidéo), routage audio et qualité.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [status, setStatus] = useState<CallStatus>('idle');
  const [peer, setPeer] = useState<CallPeer | null>(null);
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
  statusRef.current = status;
  const speakerRef = useRef(false);
  const mutedRef = useRef(false);
  const videoCallRef = useRef(false);
  const cameraOnRef = useRef(false);
  const facingRef = useRef<CameraFacing>('user');
  const politeRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const bitrateRef = useRef(CALL_VIDEO_MAX_BITRATE);
  const badSamplesRef = useRef(0);
  const resumeCameraRef = useRef(false);
  /** Une seule opération caméra à la fois (getUserMedia, bascule, arrêt). */
  const cameraBusyRef = useRef(false);
  const cameraReleasePromiseRef = useRef<Promise<void> | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const remoteReadyRef = useRef(false);
  const pendingCandidatesRef = useRef<unknown[]>([]);
  const pendingActionRef = useRef<{ callId: string; action: DeepLinkAction } | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const weakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhase = useCallback((next: CallStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const stopQualityMonitor = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
  }, []);

  /**
   * La capture native n'est vraiment libérée qu'après `release()`, mais la
   * libération immédiate d'une texture encore alimentée par la caméra fait
   * planter libwebrtc sur certains appareils (« updateTexImage »). On laisse
   * donc retomber les dernières images avant de libérer.
   */
  const releaseVideoTrackSoon = useCallback((track: MediaStreamTrack) => {
    cameraReleasePromiseRef.current = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          track.release();
        } catch {
          /* déjà libérée */
        }
        resolve();
      }, 600);
    });
  }, []);

  const closePeer = useCallback(() => {
    // Arrêter les pistes avant de fermer la connexion : c'est l'ordre qui
    // évite les textures caméra encore alimentées pendant le teardown.
    const audio = audioStreamRef.current;
    audioStreamRef.current = null;
    audio?.getTracks().forEach((track) => track.stop());
    const video = videoTrackRef.current;
    videoTrackRef.current = null;
    try {
      video?.stop();
    } catch {
      /* déjà arrêtée */
    }
    if (video) releaseVideoTrackSoon(video);
    try {
      pcRef.current?.close();
    } catch {
      /* déjà fermé */
    }
    pcRef.current = null;
    remoteReadyRef.current = false;
    pendingCandidatesRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    videoSenderRef.current = null;
    stopQualityMonitor();
    stopCallAudio();
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, [releaseVideoTrackSoon, stopQualityMonitor]);

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
      speakerRef.current = false;
      mutedRef.current = false;
      videoCallRef.current = false;
      cameraOnRef.current = false;
      facingRef.current = 'user';
      resumeCameraRef.current = false;
      bitrateRef.current = CALL_VIDEO_MAX_BITRATE;
      badSamplesRef.current = 0;
      setSpeakerOn(false);
      setMuted(false);
      setStartedAt(null);
      setMinimized(false);
      setVideoCall(false);
      setLocalCameraOn(false);
      setRemoteCameraOn(false);
      setLocalStream(null);
      setRemoteStream(null);
      setFacing('user');
      setWeakConnection(false);
      setNetworkPath(null);
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

  const emit = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      if (!token) return;
      connectSocket(token).emit(event, payload);
    },
    [token],
  );

  /* ----------------------------- Routage audio ----------------------------- */

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

  /* ------------------------------- Permissions ------------------------------- */

  const askMicrophone = useCallback(async (): Promise<boolean> => {
    try {
      const permission = await requestRecordingPermissionsAsync();
      return permission.granted;
    } catch {
      return false;
    }
  }, []);

  const askCamera = useCallback(async (): Promise<boolean> => {
    try {
      const permission = await Camera.requestCameraPermissionsAsync();
      return permission.granted;
    } catch {
      return false;
    }
  }, []);

  const showMicrophoneDenied = useCallback(() => {
    Alert.alert('Micro requis', 'Autorisez le microphone pour passer un appel vocal.', [
      { text: 'Plus tard', style: 'cancel' },
      { text: 'Ouvrir les réglages', onPress: () => void Linking.openSettings() },
    ]);
  }, []);

  const showCameraDenied = useCallback(() => {
    Alert.alert(
      'Caméra refusée',
      'La caméra est refusée : l’appel continue en vocal. Vous pouvez l’autoriser dans les réglages.',
      [
        { text: 'Plus tard', style: 'cancel' },
        { text: 'Ouvrir les réglages', onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const showCameraEmulator = useCallback(() => {
    Alert.alert(
      'Caméra indisponible',
      'Cet émulateur ne fournit pas de flux vidéo utilisable. L’appel continue en vocal ; testez la vidéo sur un téléphone.',
    );
  }, []);

  const showWeakConnection = useCallback(() => {    setWeakConnection(true);
    if (weakTimerRef.current) clearTimeout(weakTimerRef.current);
    weakTimerRef.current = setTimeout(() => {
      weakTimerRef.current = null;
      setWeakConnection(false);
    }, WEAK_NOTICE_MS);
  }, []);

  /* ------------------------------- Média vidéo ------------------------------- */

  const getVideoTrack = useCallback(async (facingMode: CameraFacing): Promise<MediaStreamTrack> => {
    // Une caméra précédente est encore en cours de libération : on attend.
    if (cameraReleasePromiseRef.current) {
      await cameraReleasePromiseRef.current;
      cameraReleasePromiseRef.current = null;
    }
    const stream = (await mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: 640,
        height: 480,
        frameRate: CALL_VIDEO_FPS,
        facingMode,
      },
    })) as MediaStream;
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error('Caméra indisponible');
    }
    return track;
  }, []);

  /** Plafond d'encodage : la vidéo cède avant l'audio sur un réseau faible. */
  const applyVideoParams = useCallback(async (sender: RTCRtpSender, maxBitrate: number) => {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{} as any];
      }
      params.encodings[0].maxBitrate = maxBitrate;
      params.encodings[0].maxFramerate = CALL_VIDEO_FPS;
      params.degradationPreference = 'balanced';
      await sender.setParameters(params);
      bitrateRef.current = maxBitrate;
    } catch {
      /* certains chemins natifs ignorent les paramètres */
    }
  }, []);

  const attachVideoTrack = useCallback(
    async (track: MediaStreamTrack) => {
      const pc = pcRef.current;
      if (!pc) return;
      let sender = videoSenderRef.current;
      if (sender) {
        await sender.replaceTrack(track);
      } else {
        sender = pc.addTrack(track, new MediaStream([track]));
        videoSenderRef.current = sender;
      }
      await applyVideoParams(sender, bitrateRef.current);
    },
    [applyVideoParams],
  );

  const enableCamera = useCallback(
    async (options?: { notify?: boolean }): Promise<boolean> => {
      if (cameraOnRef.current) return true;
      if (CAMERA_UNAVAILABLE_EMULATOR) {
        showCameraEmulator();
        return false;
      }
      // Une libération différée est encore en cours : on la laisse finir.
      if (cameraReleasePromiseRef.current) {
        await cameraReleasePromiseRef.current;
        cameraReleasePromiseRef.current = null;
      }
      const allowed = await askCamera();
      if (!allowed) {
        showCameraDenied();
        return false;
      }
      let track: MediaStreamTrack;
      try {
        track = await getVideoTrack(facingRef.current);
      } catch {
        Alert.alert('Caméra indisponible', 'Impossible d’ouvrir la caméra. L’appel continue en vocal.');
        return false;
      }
      videoTrackRef.current = track;
      cameraOnRef.current = true;
      setLocalCameraOn(true);
      setLocalStream(new MediaStream([track]));
      setVideoMode(true);
      try {
        await attachVideoTrack(track);
      } catch {
        /* la piste sera reprise à la prochaine négociation */
      }
      if (options?.notify !== false && callIdRef.current) {
        emit('call:video-toggle', { callId: callIdRef.current, video: true });
      }
      return true;
    },
    [applyVideoParams, askCamera, attachVideoTrack, emit, getVideoTrack, setVideoMode, showCameraDenied, showCameraEmulator],
  );

  /** Coupe vraiment la capture (batterie/données) et prévient l'autre. */
  const disableCamera = useCallback(
    async (notify = true) => {
      const sender = videoSenderRef.current;
      const track = videoTrackRef.current;
      videoTrackRef.current = null;
      cameraOnRef.current = false;
      setLocalCameraOn(false);
      setLocalStream(null);
      try {
        await sender?.replaceTrack(null as any);
      } catch {
        /* piste déjà retirée */
      }
      try {
        track?.stop();
      } catch {
        /* déjà arrêtée */
      }
      if (track) {
        releaseVideoTrackSoon(track);
      }
      if (notify && callIdRef.current) {
        emit('call:video-toggle', { callId: callIdRef.current, video: false });
      }
    },
    [emit, releaseVideoTrackSoon],
  );

  const toggleCamera = useCallback(async () => {
    const current = statusRef.current as CallStatus;
    if (
      current !== 'outgoing' &&
      current !== 'connecting' &&
      current !== 'active' &&
      current !== 'reconnecting'
    ) {
      return;
    }
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    try {
      if (cameraOnRef.current) {
        await disableCamera(true);
      } else {
        await enableCamera();
      }
    } finally {
      cameraBusyRef.current = false;
    }
  }, [disableCamera, enableCamera]);

  /**
   * Bascule avant/arrière via `applyConstraints` : pas de seconde session de
   * capture ni de destruction de texture (source du crash updateTexImage).
   */
  const flipCamera = useCallback(async () => {
    const track = videoTrackRef.current;
    if (!cameraOnRef.current || !track || cameraBusyRef.current) return;
    const next: CameraFacing = facingRef.current === 'user' ? 'environment' : 'user';
    cameraBusyRef.current = true;
    try {
      await track.applyConstraints({
        width: 640,
        height: 480,
        frameRate: CALL_VIDEO_FPS,
        facingMode: next,
      });
      facingRef.current = next;
      setFacing(next);
    } catch {
      Alert.alert('Caméra indisponible', 'Impossible de changer de caméra.');
    } finally {
      cameraBusyRef.current = false;
    }
  }, []);

  /* --------------------------- Qualité et dégradation --------------------------- */

  const cutVideoForWeakNetwork = useCallback(async () => {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    try {
      await disableCamera(true);
      showWeakConnection();
    } finally {
      cameraBusyRef.current = false;
    }
  }, [disableCamera, showWeakConnection]);

  const sampleQuality = useCallback(async () => {
    const pc = pcRef.current;
    const sender = videoSenderRef.current;
    if (!pc || !sender || !cameraOnRef.current) {
      badSamplesRef.current = 0;
      return;
    }
    try {
      const report: any = await pc.getStats();
      let available: number | null = null;
      let sent = 0;
      report.forEach((entry: any) => {
        if (
          entry.type === 'candidate-pair' &&
          entry.state === 'succeeded' &&
          entry.availableOutgoingBitrate
        ) {
          available = entry.availableOutgoingBitrate;
        }
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
          sent = entry.bytesSent ?? 0;
        }
      });
      if (__DEV__) {
        console.log(
          `[call] vidéo ${Math.round(sent / 1024)} Ko envoyés, dispo ${available ?? '?'} bps`,
        );
      }
      // Le maxima du TURN et de la 4G restent modestes : on dégrade par paliers.
      if (!available || available <= 0 || available >= 400_000) {
        badSamplesRef.current = 0;
        return;
      }
      badSamplesRef.current += 1;
      if (badSamplesRef.current < 2) {
        return;
      }
      badSamplesRef.current = 0;
      if (available < 200_000) {
        await cutVideoForWeakNetwork();
        return;
      }
      if (bitrateRef.current > CALL_VIDEO_STEP_BITRATE) {
        await applyVideoParams(sender, CALL_VIDEO_STEP_BITRATE);
        return;
      }
      if (bitrateRef.current > CALL_VIDEO_LOW_BITRATE) {
        await applyVideoParams(sender, CALL_VIDEO_LOW_BITRATE);
        return;
      }
      // Déjà au plancher : la vidéo cède, l'audio continue.
      await cutVideoForWeakNetwork();
    } catch {
      /* statistiques indisponibles */
    }
  }, [applyVideoParams, cutVideoForWeakNetwork]);

  const startQualityMonitor = useCallback(() => {
    stopQualityMonitor();
    statsTimerRef.current = setInterval(() => {
      void sampleQuality();
    }, QUALITY_SAMPLE_MS);
  }, [sampleQuality, stopQualityMonitor]);

  /* --------------------------- Reconnexion et négociation --------------------------- */

  /** Candidat retenu : « relay » confirme que le TURN fait le travail. */
  const inspectCandidate = useCallback((pc: RTCPeerConnection) => {
    void pc
      .getStats()
      .then((report: any) => {
        const locals = new Map<string, any>();
        const pairs: any[] = [];
        report.forEach((entry: any) => {
          if (entry.type === 'local-candidate') {
            locals.set(entry.id, entry);
          } else if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
            pairs.push(entry);
          }
        });
        const pair = pairs.find((entry) => entry.selected) ?? pairs[0];
        const local = pair ? locals.get(pair.localCandidateId) : null;
        if (local?.candidateType) {
          setNetworkPath(local.candidateType);
          if (__DEV__) {
            console.log(
              `[call] candidat ICE: ${local.candidateType}/${local.protocol} (${local.address ?? '?'})`,
            );
          }
        }
      })
      .catch(() => undefined);
  }, []);

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (statusRef.current === 'reconnecting') {
      setPhase('active');
    }
  }, [setPhase]);

  const beginReconnect = useCallback(() => {
    if (statusRef.current !== 'active' && statusRef.current !== 'connecting') {
      return;
    }
    setPhase('reconnecting');
    if (reconnectTimerRef.current) {
      return;
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (callIdRef.current) {
        emit('call:end', { callId: callIdRef.current });
      }
      finish('Connexion perdue');
    }, CALL_RECONNECT_GRACE_MS);
  }, [emit, finish, setPhase]);

  /** Négociation parfaite : le poli cède (rollback), l'impoli ignore. */
  const negotiate = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !callIdRef.current) return;
    // Une réponse en cours va stabiliser la session : on repartira après.
    if (pc.signalingState !== 'stable') return;
    try {
      makingOfferRef.current = true;
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      emit('call:offer', { callId: callIdRef.current, sdp: (pc.localDescription as any)?.sdp });
    } catch {
      finish('Connexion impossible');
    } finally {
      makingOfferRef.current = false;
    }
  }, [emit, finish]);

  /* ------------------------------ Média WebRTC ------------------------------ */

  const ensurePeer = useCallback(() => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    pc.addEventListener('icecandidate', (event: any) => {
      const candidate = event?.candidate;
      if (candidate) {
        emit('call:ice', { callId: callIdRef.current, candidate: candidate.toJSON?.() ?? candidate });
      }
    });
    pc.addEventListener('negotiationneeded', () => {
      void negotiate();
    });
    pc.addEventListener('track', (event: any) => {
      const track = event?.track;
      if (!track) return;
      if (track.kind === 'video') {
        const stream = event.streams?.[0] ?? new MediaStream([track]);
        setRemoteStream(stream);
        setRemoteCameraOn(true);
        setVideoMode(true);
        try {
          track.addEventListener?.('ended', () => setRemoteCameraOn(false));
        } catch {
          /* l'événement n'existe pas sur toutes les plateformes */
        }
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      const state = (pc as any).connectionState;
      if (state === 'connected') {
        if (statusRef.current === 'connecting') {
          setStartedAt(Date.now());
          setPhase('active');
        } else if (statusRef.current === 'reconnecting') {
          clearReconnect();
        }
        const sender = videoSenderRef.current;
        if (sender) void applyVideoParams(sender, bitrateRef.current);
        inspectCandidate(pc);
        startQualityMonitor();
      } else if (state === 'disconnected') {
        beginReconnect();
      } else if (state === 'failed') {
        if (callIdRef.current) emit('call:end', { callId: callIdRef.current });
        finish('Connexion perdue');
      }
    });
    pcRef.current = pc;
    return pc;
  }, [
    applyVideoParams,
    beginReconnect,
    clearReconnect,
    emit,
    finish,
    inspectCandidate,
    negotiate,
    setPhase,
    setVideoMode,
    startQualityMonitor,
  ]);

  const ensureLocalStream = useCallback(async () => {
    if (audioStreamRef.current) return audioStreamRef.current;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const stream = (await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })) as MediaStream;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !mutedRef.current;
    });
    audioStreamRef.current = stream;
    const pc = ensurePeer();
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    return stream;
  }, [ensurePeer]);

  const applyPendingCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const queued = pendingCandidatesRef.current.splice(0);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate as any));
      } catch {
        /* candidat tardif ignoré */
      }
    }
  }, []);

  /* ------------------------------- Cycle d'appel ------------------------------- */

  const startCall = useCallback(
    async (conversationId: string, options?: { video?: boolean }) => {
      if (statusRef.current !== 'idle' || !token) {
        return;
      }
      setPhase('preparing');
      const micAllowed = await askMicrophone();
      if ((statusRef.current as CallStatus) !== 'preparing') {
        return;
      }
      if (!micAllowed) {
        setPhase('idle');
        showMicrophoneDenied();
        return;
      }

      let wantVideo = options?.video === true;
      let cameraTrack: MediaStreamTrack | null = null;
      if (wantVideo && CAMERA_UNAVAILABLE_EMULATOR) {
        showCameraEmulator();
        wantVideo = false;
      }
      if (wantVideo) {
        const cameraAllowed = await askCamera();
        if (!cameraAllowed) {
          showCameraDenied();
          wantVideo = false;
        } else {
          try {
            cameraTrack = await getVideoTrack(facingRef.current);
          } catch {
            Alert.alert('Caméra indisponible', 'L’appel démarre en vocal.');
            wantVideo = false;
          }
        }
      }
      if ((statusRef.current as CallStatus) !== 'preparing') {
        cameraTrack?.stop();
        return;
      }

      setEndReason(null);
      setMinimized(false);
      politeRef.current = false;
      setVideoMode(wantVideo);
      applySpeaker(wantVideo);
      if (cameraTrack) {
        videoTrackRef.current = cameraTrack;
        cameraOnRef.current = true;
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
        },
      );
    },
    [
      applySpeaker,
      askCamera,
      askMicrophone,
      finish,
      getVideoTrack,
      setPhase,
      setVideoMode,
      showCameraDenied,
      showCameraEmulator,
      showMicrophoneDenied,
      token,
    ],
  );

  const accept = useCallback(
    async (withVideo = false) => {
      const callId = callIdRef.current;
      if (!callId || statusRef.current !== 'incoming') return;
      setPhase('connecting');
      stopRing();
      const micAllowed = await askMicrophone();
      // L'appel a pu être annulé pendant la demande de permission.
      if ((statusRef.current as CallStatus) !== 'connecting') {
        return;
      }
      if (!micAllowed) {
        emit('call:reject', { callId, reason: 'declined' });
        showMicrophoneDenied();
        finish('Micro inaccessible');
        return;
      }

      let wantedVideo = withVideo;
      let cameraTrack: MediaStreamTrack | null = null;
      if (wantedVideo && CAMERA_UNAVAILABLE_EMULATOR) {
        showCameraEmulator();
        wantedVideo = false;
      }
      if (wantedVideo) {
        const cameraAllowed = await askCamera();
        if (!cameraAllowed) {
          showCameraDenied();
          wantedVideo = false;
        } else {
          try {
            cameraTrack = await getVideoTrack(facingRef.current);
          } catch {
            wantedVideo = false;
          }
        }
      }
      if ((statusRef.current as CallStatus) !== 'connecting') {
        cameraTrack?.stop();
        return;
      }

      if (wantedVideo) {
        setVideoMode(true);
      }
      startCallAudio(handleProximity);
      // Après `start` : c'est lui qui remet la route audio par défaut.
      applySpeaker(videoCallRef.current);
      try {
        await ensureLocalStream();
        if (cameraTrack) {
          videoTrackRef.current = cameraTrack;
          cameraOnRef.current = true;
          setLocalCameraOn(true);
          setLocalStream(new MediaStream([cameraTrack]));
          await attachVideoTrack(cameraTrack);
        }
      } catch {
        emit('call:reject', { callId, reason: 'declined' });
        finish('Micro inaccessible');
        return;
      }
      emit('call:accept', { callId, video: wantedVideo });
      pendingActionRef.current = null;
    },
    [
      applySpeaker,
      askCamera,
      askMicrophone,
      attachVideoTrack,
      emit,
      ensureLocalStream,
      finish,
      getVideoTrack,
      handleProximity,
      setPhase,
      setVideoMode,
      showCameraDenied,
      showCameraEmulator,
      showMicrophoneDenied,
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
      const wasRinging = statusRef.current === 'outgoing';
      emit(wasRinging ? 'call:cancel' : 'call:end', { callId });
    }
    finish('Appel terminé');
  }, [emit, finish]);

  const toggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      mutedRef.current = next;
      audioStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  const toggleSpeaker = useCallback(() => {
    applySpeaker(!speakerRef.current);
  }, [applySpeaker]);

  const minimize = useCallback(() => {
    const current = statusRef.current;
    if (
      current === 'outgoing' ||
      current === 'connecting' ||
      current === 'active' ||
      current === 'reconnecting'
    ) {
      // Réduit : la caméra s'arrête (batterie/données), l'audio continue.
      if (cameraOnRef.current && !cameraBusyRef.current) {
        resumeCameraRef.current = true;
        cameraBusyRef.current = true;
        void disableCamera(true).finally(() => {
          cameraBusyRef.current = false;
        });
      }
      setMinimized(true);
    }
  }, [disableCamera]);

  const restore = useCallback(() => {
    setMinimized(false);
    if (!resumeCameraRef.current || cameraBusyRef.current) return;
    resumeCameraRef.current = false;
    const current = statusRef.current;
    if (
      current === 'outgoing' ||
      current === 'connecting' ||
      current === 'active' ||
      current === 'reconnecting'
    ) {
      cameraBusyRef.current = true;
      void enableCamera().finally(() => {
        cameraBusyRef.current = false;
      });
    }
  }, [enableCamera]);

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

  /* ------------------------- Événements de signalisation ------------------------- */

  useEffect(() => {
    if (!token) return;
    const socket = connectSocket(token);

    const onIncoming = (payload: {
      callId: string;
      from: CallPeer;
      video?: boolean;
    }) => {
      if (statusRef.current !== 'idle') {
        // Déjà en appel : le serveur gère le « busy » ; on ignore simplement.
        return;
      }
      callIdRef.current = payload.callId;
      setPeer(payload.from);
      setEndReason(null);
      setMinimized(false);
      setRemoteCameraOn(false);
      politeRef.current = true;
      if (payload.video === true) {
        setVideoMode(true);
      } else {
        setVideoMode(false);
        applySpeaker(false);
      }
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

    const onAccepted = async (payload: { video?: boolean }) => {
      if (statusRef.current !== 'outgoing') return;
      setPhase('connecting');
      stopRing();
      startCallAudio(handleProximity);
      // Après `start` : c'est lui qui remet la route audio par défaut.
      applySpeaker(videoCallRef.current);
      try {
        await ensureLocalStream();
        const pendingTrack = videoTrackRef.current;
        if (pendingTrack) {
          await attachVideoTrack(pendingTrack);
        }
      } catch {
        emit('call:end', { callId: callIdRef.current });
        finish('Connexion impossible');
        return;
      }
      if (payload.video === true) {
        setRemoteCameraOn(true);
      }
    };

    const onOffer = async (payload: { callId: string; sdp: string }) => {
      if (callIdRef.current !== payload.callId) return;
      const pc = ensurePeer();
      // Une offer déjà reçue et en cours de traitement : on ignore la copie.
      if (pc.signalingState === 'have-remote-offer') return;
      const polite = politeRef.current;
      const collision = makingOfferRef.current || pc.signalingState !== 'stable';
      ignoreOfferRef.current = collision && !polite;
      if (ignoreOfferRef.current) {
        return;
      }
      try {
        if (collision && polite && pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' } as any);
        }
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }));
        remoteReadyRef.current = true;
        await applyPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        emit('call:answer', { callId: callIdRef.current, sdp: (pc.localDescription as any)?.sdp });
      } catch {
        finish('Connexion impossible');
      }
    };

    const onAnswer = async (payload: { callId: string; sdp: string }) => {
      if (callIdRef.current !== payload.callId) return;
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
        remoteReadyRef.current = true;
        await applyPendingCandidates();
      } catch {
        /* answer déjà appliquée */
      }
    };

    const onIce = async (payload: { callId: string; candidate: unknown }) => {
      if (callIdRef.current !== payload.callId) return;
      const pc = pcRef.current;
      if (!pc || !remoteReadyRef.current) {
        pendingCandidatesRef.current.push(payload.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate as any));
      } catch {
        /* candidat obsolète */
      }
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
    const onEnded = (payload: { reason: string; durationMs: number }) => {
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
    };
  }, [
    accept,
    applyPendingCandidates,
    applySpeaker,
    attachVideoTrack,
    emit,
    ensureLocalStream,
    ensurePeer,
    finish,
    handleProximity,
    reject,
    setPhase,
    setVideoMode,
    token,
  ]);

  // Socket perdu pendant un appel : « Reconnexion… » puis fin après la grâce.
  useEffect(() => {
    const off = onConnection((connected) => {
      if (!connected) {
        if (statusRef.current === 'active' || statusRef.current === 'connecting') {
          beginReconnect();
        }
        return;
      }
      const pcState = (pcRef.current as any)?.connectionState;
      if (statusRef.current === 'reconnecting' && pcState === 'connected') {
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
