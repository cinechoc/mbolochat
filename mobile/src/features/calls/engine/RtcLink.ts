import {
  MediaStream,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  type MediaStreamTrack,
  type RTCRtpSender,
} from 'react-native-webrtc';

import type { IceServerConfig } from '@/lib/ice';
import { applyAudioBitrate, readLinkStats, type LinkStats } from './PeerStats';
import { tuneOpusSdp } from './sdp';

export type LinkState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type LinkSignal = 'offer' | 'answer' | 'ice';

export interface RtcLinkDeps {
  iceServers: IceServerConfig[];
  /** Envoi de la signalisation vers ce pair (le provider connaît callId et peerId). */
  send: (event: LinkSignal, payload: { sdp?: string; candidate?: unknown }) => void;
  /** Pair « poli » : il cède son offer en cas de collision. Doit rester asymétrique. */
  polite: boolean;
}

/**
 * Un lien WebRTC vers un pair. L'appel un à un n'en possède qu'un, l'appel de
 * groupe un par participant : la négociation est identique dans les deux cas.
 */
export class RtcLink {
  readonly peerId: string;

  private readonly pc: RTCPeerConnection;
  private readonly deps: RtcLinkDeps;
  private readonly publishedTrackIds = new Set<string>();
  private pendingCandidates: unknown[] = [];
  private haveRemoteDescription = false;
  private makingOffer = false;
  private ignoreOffer = false;
  /**
   * Un lien n'envoie d'offer que s'il a été déclaré « ouvrant ». En maillage,
   * c'est toujours l'arrivant qui ouvre : sans ce verrou, les deux côtés
   * publieraient en même temps et chaque jointure produirait une collision.
   */
  private mayNegotiate = false;
  private closed = false;
  private videoSender: RTCRtpSender | null = null;
  private onRemoteTrackListener: ((track: MediaStreamTrack, stream: MediaStream) => void) | null =
    null;
  private onStateListener: ((state: LinkState) => void) | null = null;

  constructor(peerId: string, deps: RtcLinkDeps) {
    this.peerId = peerId;
    this.deps = deps;
    this.pc = new RTCPeerConnection({
      iceServers: deps.iceServers,
      // Petite réserve de candidats : la connexion démarre plus vite sans
      // gaspiller de ports sur un téléphone.
      iceCandidatePoolSize: 2,
    } as never);

    this.pc.addEventListener('icecandidate', (event: any) => {
      const candidate = event?.candidate;
      if (candidate) {
        deps.send('ice', { candidate: candidate.toJSON?.() ?? candidate });
      }
    });
    this.pc.addEventListener('negotiationneeded', () => {
      if (this.mayNegotiate) {
        void this.negotiate();
      }
    });
    this.pc.addEventListener('track', (event: any) => {
      const track = event?.track as MediaStreamTrack | undefined;
      if (!track) {
        return;
      }
      const stream = (event.streams?.[0] ?? new MediaStream([track])) as MediaStream;
      this.onRemoteTrackListener?.(track, stream);
    });
    this.pc.addEventListener('connectionstatechange', () => {
      this.onStateListener?.(this.connectionState);
    });
  }

  get connectionState(): LinkState {
    if (this.closed) {
      return 'closed';
    }
    return ((this.pc as any).connectionState as LinkState) ?? 'new';
  }

  get signalingState(): string {
    return (this.pc as any).signalingState ?? 'stable';
  }

  get localDescriptionSdp(): string | undefined {
    return (this.pc.localDescription as any)?.sdp;
  }

  onRemoteTrack(listener: (track: MediaStreamTrack, stream: MediaStream) => void): void {
    this.onRemoteTrackListener = listener;
  }

  onStateChange(listener: (state: LinkState) => void): void {
    this.onStateListener = listener;
    listener(this.connectionState);
  }

  /** Publie une piste locale une seule fois (le micro est partagé par tous les liens). */
  publish(track: MediaStreamTrack, stream: MediaStream | null): void {
    const key = `${track.kind}:${track.id}`;
    if (this.closed || this.publishedTrackIds.has(key)) {
      return;
    }
    this.publishedTrackIds.add(key);
    if (track.kind === 'audio') {
      const sender = stream ? this.pc.addTrack(track, stream) : this.pc.addTrack(track);
      void applyAudioBitrate(sender);
      return;
    }
    if (track.kind === 'video') {
      this.videoSender = stream
        ? this.pc.addTrack(track, stream)
        : this.pc.addTrack(track);
      return;
    }
    if (stream) {
      this.pc.addTrack(track, stream);
    } else {
      this.pc.addTrack(track);
    }
  }

  /**
   * Caméra qui s'allume ou s'éteint en cours d'appel : on remplace la piste du
   * sender existant quand il y en a un, sinon on en ajoute un.
   */
  async setVideoTrack(track: MediaStreamTrack | null, stream: MediaStream | null): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.videoSender) {
      await this.videoSender.replaceTrack(track as never);
      if (track) {
        this.publishedTrackIds.add(`video:${track.id}`);
      }
      return;
    }
    if (track) {
      this.publish(track, stream);
    }
  }

  get videoSenderRef(): RTCRtpSender | null {
    return this.videoSender;
  }

  /** Démarre la négociation : c'est l'arrivant qui ouvre le lien. */
  initiate(): void {
    this.mayNegotiate = true;
    void this.negotiate();
  }

  /** Ajout ou retrait de la caméra en cours d'appel : le lien reprend la main. */
  renegotiate(): void {
    this.mayNegotiate = true;
    void this.negotiate();
  }

  async negotiate(): Promise<void> {
    if (this.closed || this.pc.signalingState !== 'stable') {
      return;
    }
    try {
      this.makingOffer = true;
      const offer = (await this.pc.createOffer({})) as { sdp?: string };
      if (this.closed) {
        return;
      }
      await this.pc.setLocalDescription({ type: 'offer', sdp: tuneOpusSdp(offer.sdp ?? '') } as never);
      if (this.closed) {
        return;
      }
      this.deps.send('offer', { sdp: this.localDescriptionSdp });
    } catch {
      /* la prochaine relance de négociation reprendra la main */
    } finally {
      this.makingOffer = false;
    }
  }

  async handleOffer(sdp: string): Promise<'answered' | 'ignored' | 'failed'> {
    if (this.closed || !sdp) {
      return 'failed';
    }
    if (this.pc.signalingState === 'have-remote-offer') {
      return 'ignored';
    }
    const collision = this.makingOffer || this.pc.signalingState !== 'stable';
    this.ignoreOffer = collision && !this.deps.polite;
    if (this.ignoreOffer) {
      return 'ignored';
    }
    try {
      if (collision && this.deps.polite && this.pc.signalingState === 'have-local-offer') {
        await this.pc.setLocalDescription({ type: 'rollback' } as never);
      }
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      if (this.closed) {
        return 'failed';
      }
      this.haveRemoteDescription = true;
      await this.flushCandidates();
      const answer = (await this.pc.createAnswer()) as { sdp?: string };
      if (this.closed) {
        return 'failed';
      }
      await this.pc.setLocalDescription({ type: 'answer', sdp: tuneOpusSdp(answer.sdp ?? '') } as never);
      if (this.closed) {
        return 'failed';
      }
      this.deps.send('answer', { sdp: this.localDescriptionSdp });
      return 'answered';
    } catch {
      return 'failed';
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (this.closed || !sdp) {
      return;
    }
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      if (this.closed) {
        return;
      }
      this.haveRemoteDescription = true;
      await this.flushCandidates();
    } catch {
      /* answer déjà appliquée */
    }
  }

  async handleCandidate(candidate: unknown): Promise<void> {
    if (this.closed || candidate === undefined || candidate === null) {
      return;
    }
    if (!this.haveRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate as never));
    } catch {
      /* candidat obsolète */
    }
  }

  /**
   * Redémarrage ICE : on garde le même RTCPeerConnection et la même piste
   * micro, on renégocie seulement la connectivité. C'est ce qui permet de
   * survivre à un changement de réseau sans couper l'appel.
   */
  restartIce(): void {
    if (this.closed) {
      return;
    }
    this.mayNegotiate = true;
    try {
      (this.pc as unknown as { restartIce?: () => void }).restartIce?.();
    } catch {
      /* relance assurée par l'offre ci-dessous */
    }
    void this.negotiate();
  }

  readStats(): Promise<LinkStats> {
    return readLinkStats(this.pc);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pendingCandidates = [];
    this.videoSender = null;
    try {
      this.pc.close();
    } catch {
      /* déjà fermé */
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate as never));
      } catch {
        /* candidat tardif ignoré */
      }
    }
  }
}
