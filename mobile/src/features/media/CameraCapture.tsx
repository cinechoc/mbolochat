import { Ionicons } from '@expo/vector-icons';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraType,
  type FlashMode,
} from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { MediaSurface, Radii, Spacing } from '@/constants/theme';
import { MAX_PLAINTEXT_BYTES } from '@/features/e2ee/media';
import { fr } from '@/i18n/fr';
import { isRejectedMedia, normalizeLocalMedia, type PickedAttachment } from './pickMedia';

export type CameraCaptureMode = 'photo' | 'video';

interface CameraCaptureProps {
  visible: boolean;
  initialMode: CameraCaptureMode;
  onClose: () => void;
  onCaptured: (asset: PickedAttachment) => void;
}

const MAX_VIDEO_DURATION_S = 60;
const FLASH_MODES = ['off', 'auto', 'on'] as const satisfies readonly FlashMode[];
type CaptureFlash = (typeof FLASH_MODES)[number];
const FLASH_ICONS = {
  off: 'flash-off-outline',
  auto: 'flash-outline',
  on: 'flash-outline',
} as const satisfies Record<CaptureFlash, string>;

export function CameraCapture({
  visible,
  initialMode,
  onClose,
  onCaptured,
}: CameraCaptureProps) {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [mode, setMode] = useState<CameraCaptureMode>(initialMode);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<CaptureFlash>('off');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const closingRef = useRef(false);
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);

  useEffect(() => {
    if (!visible || cameraPermission) return;
    void requestCameraPermission();
  }, [cameraPermission, requestCameraPermission, visible]);

  useEffect(
    () => () => {
      closingRef.current = true;
      if (recordingRef.current) {
        const camera = cameraRef.current;
        if (camera) camera.stopRecording();
      }
    },
    [],
  );

  const ensureMicrophone = useCallback(async (): Promise<boolean> => {
    if (microphonePermission?.granted) return true;
    const result = await requestMicrophonePermission();
    if (result.granted) return true;
    Alert.alert(fr.chat.camera.microphoneTitle, fr.chat.camera.microphoneBody);
    return false;
  }, [microphonePermission?.granted, requestMicrophonePermission]);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    try {
      cameraRef.current?.stopRecording();
    } catch {
      if (!closingRef.current) {
        Alert.alert(fr.chat.camera.failedTitle, fr.chat.camera.failedBody);
      }
    }
  }, []);

  const close = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    await stopRecording();
    onClose();
  }, [onClose, stopRecording]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || busy || recordingRef.current) return;
    setBusy(true);
    try {
      const picture = await cameraRef.current.takePictureAsync({
        quality: 1,
        exif: false,
        shutterSound: true,
      });
      const asset = normalizeLocalMedia({
        uri: picture.uri,
        kind: 'image',
        mime: picture.format === 'png' ? 'image/png' : 'image/jpeg',
        name: `photo-${Date.now()}.${picture.format}`,
        width: picture.width,
        height: picture.height,
      });
      if (isRejectedMedia(asset)) {
        Alert.alert(fr.chat.camera.failedTitle, asset.reason);
        return;
      }
      onCaptured(asset);
    } catch {
      Alert.alert(fr.chat.camera.failedTitle, fr.chat.camera.failedBody);
    } finally {
      if (!closingRef.current) setBusy(false);
    }
  }, [busy, onCaptured]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || busy || recordingRef.current) return;
    if (!(await ensureMicrophone())) return;
    setBusy(true);
    recordingRef.current = true;
    durationRef.current = 0;
    startedAtRef.current = Date.now();
    setRecording(true);
    try {
      const result = await cameraRef.current.recordAsync({
        maxDuration: MAX_VIDEO_DURATION_S,
        maxFileSize: MAX_PLAINTEXT_BYTES.video,
        progressUpdateInterval: 0.5,
      });
      if (!result || closingRef.current) return;
      const elapsed = Math.max(durationRef.current, Date.now() - startedAtRef.current);
      const asset = normalizeLocalMedia({
        uri: result.uri,
        kind: 'video',
        durationMs: elapsed,
      });
      if (isRejectedMedia(asset)) {
        Alert.alert(fr.chat.camera.failedTitle, asset.reason);
        return;
      }
      onCaptured(asset);
    } catch {
      if (!closingRef.current) {
        Alert.alert(fr.chat.camera.failedTitle, fr.chat.camera.failedBody);
      }
    } finally {
      recordingRef.current = false;
      if (!closingRef.current) {
        setRecording(false);
        setBusy(false);
      }
    }
  }, [busy, ensureMicrophone, onCaptured]);

  const onShutter = useCallback(() => {
    if (busy && !recordingRef.current) return;
    if (recordingRef.current) {
      void stopRecording();
      return;
    }
    if (mode === 'video') {
      void startRecording();
      return;
    }
    void takePhoto();
  }, [busy, mode, startRecording, stopRecording, takePhoto]);

  const changeMode = useCallback(
    (next: CameraCaptureMode) => {
      if (recordingRef.current || busy) return;
      setMode(next);
    },
    [busy],
  );

  const cycleFlash = useCallback(() => {
    const index = FLASH_MODES.indexOf(flash);
    setFlash(FLASH_MODES[(index + 1) % FLASH_MODES.length]);
  }, [flash]);

  const permissionGranted = cameraPermission?.granted === true;

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={() => void close()}>
      <View style={styles.screen}>
        {permissionGranted && visible ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            mode={mode === 'photo' ? 'picture' : 'video'}
            onCameraReady={() => setReady(true)}
            onMountError={() => {
              if (!closingRef.current) {
                Alert.alert(fr.chat.camera.failedTitle, fr.chat.camera.failedBody);
              }
            }}
            onRecordingProgress={(event) => {
              durationRef.current = event.duration * 1000;
            }}
          />
        ) : null}

        <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
          <Pressable
            onPress={() => void close()}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={fr.chat.camera.close}
            style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}>
            <Ionicons name="close" size={25} color={MediaSurface.onSurface} />
          </Pressable>
          {permissionGranted ? (
            <View style={styles.headerActions}>
              <Pressable
                onPress={cycleFlash}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={fr.chat.camera.title}
                style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}>
                <Ionicons
                  name={FLASH_ICONS[flash]}
                  size={21}
                  color={MediaSurface.onSurface}
                />
              </Pressable>
              <Pressable
                onPress={() => setFacing((current) => (current === 'back' ? 'front' : 'back'))}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={fr.chat.camera.flip}
                style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}>
                <Ionicons name="camera-reverse-outline" size={23} color={MediaSurface.onSurface} />
              </Pressable>
            </View>
          ) : null}
        </View>

        {!permissionGranted ? (
          <View style={styles.permissionPane}>
            <View style={styles.permissionIcon}>
              <Ionicons name="camera-outline" size={30} color={MediaSurface.onSurface} />
            </View>
            <ThemedText type="sectionTitle" style={styles.onSurface}>
              {fr.chat.camera.permissionTitle}
            </ThemedText>
            <ThemedText type="small" style={styles.onSurfaceSoftCenter}>
              {fr.chat.camera.permissionBody}
            </ThemedText>
            <Pressable
              onPress={() => void Linking.openSettings()}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.permissionAction,
                pressed && styles.pressed,
              ]}>
              <ThemedText type="smallBold" style={styles.onSurface}>
                {fr.common.openSettings}
              </ThemedText>
            </Pressable>
          </View>
        ) : (
          <View
            style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.four) }]}>
            <View style={styles.modeSwitch}>
              {(['photo', 'video'] as const).map((value) => {
                const active = mode === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => changeMode(value)}
                    disabled={recording || busy}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled: recording || busy }}
                    style={[styles.modeButton, active && styles.modeButtonActive]}>
                    <ThemedText
                      type="smallBold"
                      style={active ? styles.onSurface : styles.onSurfaceSoft}>
                      {value === 'photo' ? fr.chat.camera.photo : fr.chat.camera.video}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.shutterRow}>
              <View style={styles.shutterSide} />
              <Pressable
                onPress={onShutter}
                disabled={!ready}
                accessibilityRole="button"
                accessibilityLabel={
                  recording
                    ? fr.chat.camera.stopVideo
                    : mode === 'video'
                      ? fr.chat.camera.startVideo
                      : fr.chat.camera.capturePhoto
                }
                accessibilityState={{ disabled: !ready, busy: busy }}
                style={({ pressed }) => [
                  styles.shutter,
                  recording && styles.shutterRecording,
                  !ready && styles.disabled,
                  pressed && styles.shutterPressed,
                ]}>
                {busy && !recording ? (
                  <ActivityIndicator color={MediaSurface.onSurface} />
                ) : recording ? (
                  <View style={styles.stopMark} />
                ) : (
                  <View style={styles.shutterCore} />
                )}
              </Pressable>
              <View style={styles.shutterSide}>
                {recording ? (
                  <View style={styles.recordingBadge}>
                    <View style={styles.recordingDot} />
                    <ThemedText type="micro" style={styles.onSurface}>
                      {fr.chat.camera.recording}
                    </ThemedText>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: MediaSurface.background },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    backgroundColor: MediaSurface.overlay,
  },
  headerActions: { flexDirection: 'row', gap: Spacing.two },
  roundButton: {
    width: 42,
    height: 42,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MediaSurface.glass,
  },
  permissionPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
  },
  permissionIcon: {
    width: 64,
    height: 64,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MediaSurface.glass,
  },
  permissionAction: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.glassStrong,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: Spacing.three,
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    backgroundColor: MediaSurface.overlay,
  },
  modeSwitch: {
    alignSelf: 'center',
    flexDirection: 'row',
    padding: 3,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.glass,
  },
  modeButton: {
    minWidth: 72,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderRadius: Radii.full,
  },
  modeButtonActive: { backgroundColor: MediaSurface.glassStrong },
  shutterRow: { flexDirection: 'row', alignItems: 'center' },
  shutterSide: { flex: 1, alignItems: 'flex-end' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 5,
    borderColor: MediaSurface.onSurface,
    backgroundColor: MediaSurface.glassStrong,
  },
  shutterRecording: { borderColor: MediaSurface.recording },
  shutterPressed: { transform: [{ scale: 0.94 }] },
  shutterCore: {
    width: 58,
    height: 58,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.onSurface,
  },
  stopMark: {
    width: 28,
    height: 28,
    borderRadius: Radii.sm,
    backgroundColor: MediaSurface.recording,
  },
  recordingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.overlay,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
    backgroundColor: MediaSurface.recording,
  },
  onSurface: { color: MediaSurface.onSurface },
  onSurfaceSoft: { color: MediaSurface.onSurfaceSoft },
  onSurfaceSoftCenter: { color: MediaSurface.onSurfaceSoft, textAlign: 'center' },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.5 },
});
