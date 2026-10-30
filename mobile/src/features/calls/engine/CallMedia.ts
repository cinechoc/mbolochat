import { Alert, Linking } from 'react-native';
import { Camera } from 'expo-camera';
import * as Device from 'expo-device';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { mediaDevices, MediaStream, type MediaStreamTrack } from 'react-native-webrtc';

import { CALL_VIDEO_FPS } from '@/lib/calls';
import type { CameraFacing } from '@/lib/calls';

/**
 * La caméra virtuelle de Waydroid ne délivre aucune image (0 fps) et fait
 * planter le thread natif de libwebrtc (« updateTexImage »). En développement,
 * on évite donc la capture sur cet émulateur : l'appel reste vocal. Les
 * téléphones réels ne sont pas concernés.
 */
export const CAMERA_UNAVAILABLE_EMULATOR =
  __DEV__ && (Device.osBuildFingerprint ?? '').toLowerCase().includes('waydroid');

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;

/** Opus mono avec suppression d'écho et de bruit : la priorité de l'audio mobile. */
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/**
 * Capture et routage du média d'un appel : micro partagé par tous les liens,
 * une seule piste caméra remplacée sur chaque sender. Le provider garde la main
 * sur l'état affiché et la signalisation.
 */
export class CallMedia {
  private mic: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private facing: CameraFacing = 'user';
  private muted = false;
  /** Une seule opération caméra à la fois (ouverture, bascule, arrêt). */
  private busy = false;
  private releasePromise: Promise<void> | null = null;

  get micStream(): MediaStream | null {
    return this.mic;
  }

  get cameraTrack(): MediaStreamTrack | null {
    return this.videoTrack;
  }

  get cameraFacing(): CameraFacing {
    return this.facing;
  }

  get cameraBusy(): boolean {
    return this.busy;
  }

  setCameraBusy(busy: boolean): void {
    this.busy = busy;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Micro coupé = piste désactivée, jamais arrêtée (pas de renégociation). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  async askMicrophone(): Promise<boolean> {
    try {
      const permission = await requestRecordingPermissionsAsync();
      return permission.granted;
    } catch {
      return false;
    }
  }

  async askCamera(): Promise<boolean> {
    try {
      const permission = await Camera.requestCameraPermissionsAsync();
      return permission.granted;
    } catch {
      return false;
    }
  }

  showMicrophoneDenied(): void {
    Alert.alert('Micro requis', 'Autorisez le microphone pour passer un appel vocal.', [
      { text: 'Plus tard', style: 'cancel' },
      { text: 'Ouvrir les réglages', onPress: () => void Linking.openSettings() },
    ]);
  }

  showCameraDenied(): void {
    Alert.alert(
      'Caméra refusée',
      'La caméra est refusée : l’appel continue en vocal. Vous pouvez l’autoriser dans les réglages.',
      [{ text: 'Plus tard', style: 'cancel' }, { text: 'Ouvrir les réglages', onPress: () => void Linking.openSettings() }],
    );
  }

  showCameraEmulator(): void {
    Alert.alert(
      'Caméra indisponible',
      'Cet émulateur ne fournit pas de flux vidéo utilisable. L’appel continue en vocal ; testez la vidéo sur un téléphone.',
    );
  }

  /** Le micro est acquis une fois pour l'appel et publié sur chaque lien. */
  async ensureMicrophone(): Promise<MediaStream> {
    if (this.mic) {
      return this.mic;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const stream = (await mediaDevices.getUserMedia({
      // Les typings de react-native-webrtc ne déclarent que les champs vidéo de
      // MediaTrackConstraints ; le natif, lui, applique bien ces options audio.
      audio: AUDIO_CONSTRAINTS as never,
      video: false,
    })) as MediaStream;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted;
    });
    this.mic = stream;
    return stream;
  }

  /**
   * Ouverture de la caméra. La libération différée d'une piste précédente est
   * attendue : détruire une texture encore alimentée fait planter libwebrtc.
   */
  async openCameraTrack(fps: number = CALL_VIDEO_FPS): Promise<MediaStreamTrack> {
    if (this.releasePromise) {
      await this.releasePromise;
      this.releasePromise = null;
    }
    const stream = (await mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        frameRate: fps,
        facingMode: this.facing,
      },
    })) as MediaStream;
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error('Caméra indisponible');
    }
    this.videoTrack = track;
    return track;
  }

  /** Bascule avant/arrière sans seconde session de capture (crash updateTexImage). */
  async flipCamera(): Promise<CameraFacing> {
    const track = this.videoTrack;
    if (!track) {
      return this.facing;
    }
    const next: CameraFacing = this.facing === 'user' ? 'environment' : 'user';
    await track.applyConstraints({
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      frameRate: CALL_VIDEO_FPS,
      facingMode: next,
    });
    this.facing = next;
    return next;
  }

  /**
   * Arrêter avant de fermer la connexion : c'est l'ordre qui évite les textures
   * caméra encore alimentées pendant le teardown.
   */
  stopCameraTrack(): MediaStreamTrack | null {
    const track = this.videoTrack;
    this.videoTrack = null;
    if (!track) {
      return null;
    }
    try {
      track.stop();
    } catch {
      /* déjà arrêtée */
    }
    this.releasePromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          track.release();
        } catch {
          /* déjà libérée */
        }
        resolve();
      }, 600);
    });
    return track;
  }

  /** Libère tout à la fin de l'appel et rend le mode audio normal. */
  async release(): Promise<void> {
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    this.stopCameraTrack();
    this.muted = false;
    this.busy = false;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }
}
