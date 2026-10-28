import {
  AlertTriangle,
  Camera,
  CameraOff,
  ChevronDown,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  SwitchCamera,
  Volume2,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import { Avatar } from '@/components/avatar';
import { useCalls } from './CallProvider';
import { LocalVideoPip } from './LocalVideoPip';

const BG = '#1E40AF';
const RED = '#FF3B30';
const GREEN = '#0BC167';
const GLASS = 'rgba(255,255,255,0.16)';

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Écran d'appel plein écran : vocal, vidéo, réduit, terminé. */
export function CallOverlay() {
  const {
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
    accept,
    reject,
    hangup,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
    flipCamera,
    minimize,
  } = useCalls();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  const ringing = status === 'incoming' || status === 'outgoing';
  const breath = useSharedValue(0);
  const ringA = useSharedValue(0);
  const ringB = useSharedValue(0);

  useEffect(() => {
    if (status !== 'active' || !startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [status, startedAt]);

  useEffect(() => {
    if (!ringing) {
      breath.value = withTiming(0, { duration: 240 });
      return;
    }
    breath.value = withRepeat(
      withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    ringA.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.out(Easing.quad) }), -1, false);
    ringB.value = withRepeat(
      withTiming(1, { duration: 2200, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(breath);
      cancelAnimation(ringA);
      cancelAnimation(ringB);
    };
  }, [ringing, breath, ringA, ringB]);

  const breathStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breath.value * 0.03 }],
  }));
  const ringAStyle = useAnimatedStyle(() => ({
    opacity: 0.35 * (1 - ringA.value),
    transform: [{ scale: 1 + ringA.value * 0.55 }],
  }));
  const ringBStyle = useAnimatedStyle(() => ({
    opacity: 0.35 * (1 - ringB.value),
    transform: [{ scale: 1 + ringB.value * 0.55 }],
  }));

  if (status === 'idle' || status === 'preparing' || minimized) {
    return null;
  }

  const name = peer?.displayName ?? 'Contact';
  const statusText =
    status === 'incoming'
      ? videoCall
        ? 'Appel vidéo entrant'
        : 'Appel vocal entrant'
      : status === 'outgoing'
        ? 'Appelle…'
        : status === 'connecting'
          ? 'Connexion…'
          : status === 'reconnecting'
            ? 'Reconnexion…'
            : status === 'active' && startedAt
              ? formatDuration(now - startedAt)
              : (endReason ?? 'Appel terminé');
  const showCard = status !== 'incoming' && status !== 'ended';
  const remoteVideoVisible = Boolean(videoCall && remoteCameraOn && remoteStream);
  const localPipVisible = Boolean(videoCall && localCameraOn && localStream);

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => undefined}>
      <GestureHandlerRootView style={styles.root}>
        {remoteVideoVisible && remoteStream ? (
          <RTCView
            streamURL={remoteStream.toURL()}
            style={styles.remoteVideo}
            objectFit="cover"
            zOrder={0}
          />
        ) : null}
        {remoteVideoVisible ? <View pointerEvents="none" style={styles.topScrim} /> : null}
        {remoteVideoVisible ? <View pointerEvents="none" style={styles.bottomScrim} /> : null}

        <View style={[styles.container, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 28 }]}>
          {showCard ? (
            <Animated.View entering={FadeInDown.duration(280)} style={styles.card}>
              <Pressable
                onPress={minimize}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Réduire l’appel"
                style={({ pressed }) => [styles.cardIcon, pressed && styles.pressed]}>
                <ChevronDown size={20} strokeWidth={2.4} color="#ffffff" />
              </Pressable>
              <Avatar name={name} uri={peer?.avatarUrl} size={40} variant="user" />
              <View style={styles.cardIdentity}>
                <Text style={styles.cardName} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={styles.cardStatus} numberOfLines={1}>
                  {statusText}
                  {__DEV__ && networkPath ? ` · ${networkPath}` : ''}
                </Text>
              </View>
              <Pressable
                onPress={toggleSpeaker}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={speakerOn ? 'Désactiver le haut-parleur' : 'Activer le haut-parleur'}
                accessibilityState={{ selected: speakerOn }}
                style={({ pressed }) => [
                  styles.cardIcon,
                  speakerOn && styles.cardIconOn,
                  pressed && styles.pressed,
                ]}>
                <Volume2 size={19} color="#ffffff" />
              </Pressable>
              <Pressable
                onPress={hangup}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={status === 'active' ? 'Raccrocher' : 'Annuler l’appel'}
                style={({ pressed }) => [styles.cardHangup, pressed && styles.pressed]}>
                <PhoneOff size={21} strokeWidth={2.2} color="#ffffff" />
              </Pressable>
            </Animated.View>
          ) : (
            <View style={styles.cardSpacer} />
          )}

          {!remoteVideoVisible ? (
            <View style={styles.stage}>
              <View style={styles.avatarStage}>
                {ringing ? (
                  <>
                    <Animated.View style={[styles.ring, ringAStyle]} />
                    <Animated.View style={[styles.ring, ringBStyle]} />
                  </>
                ) : null}
                <Animated.View style={breathStyle}>
                  <Avatar name={name} uri={peer?.avatarUrl} size={176} variant="user" />
                </Animated.View>
              </View>
              {!showCard ? (
                <View style={styles.identity}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Animated.Text key={statusText} entering={FadeIn.duration(200)} style={styles.subtitle}>
                    {statusText}
                  </Animated.Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.stage} pointerEvents="box-none" />
          )}

          {weakConnection ? (
            <Animated.View entering={FadeInDown.duration(200)} style={styles.weakToast}>
              <AlertTriangle size={15} color="#FFD166" />
              <Text style={styles.weakText}>Connexion faible — caméra coupée</Text>
            </Animated.View>
          ) : null}

          <View style={styles.bottomBar}>
            {status === 'incoming' ? (
              <View style={styles.incomingStack}>
                <View style={styles.incomingRow}>
                  <CallButton label="Refuser l’appel" background={RED} onPress={reject} delay={80}>
                    <PhoneOff size={30} color="#ffffff" />
                  </CallButton>
                  <CallButton
                    label={videoCall ? 'Accepter avec caméra' : 'Accepter l’appel'}
                    background={GREEN}
                    onPress={() => void accept(videoCall)}
                    delay={160}>
                    <Phone size={30} color="#ffffff" />
                  </CallButton>
                </View>
                {videoCall ? (
                  <Animated.View entering={FadeInDown.delay(220).duration(220)}>
                    <Pressable
                      onPress={() => void accept(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Accepter sans caméra"
                      hitSlop={8}
                      style={({ pressed }) => [styles.noCamera, pressed && styles.pressed]}>
                      <Text style={styles.noCameraText}>Répondre sans caméra</Text>
                    </Pressable>
                  </Animated.View>
                ) : null}
              </View>
            ) : status === 'ended' ? null : videoCall ? (
              <>
                <CallButton
                  label={localCameraOn ? 'Couper la caméra' : 'Activer la caméra'}
                  background={localCameraOn ? '#FFFFFF' : GLASS}
                  onPress={() => void toggleCamera()}
                  selected={localCameraOn}
                  size={64}
                  delay={60}>
                  {localCameraOn ? (
                    <Camera size={26} color={BG} />
                  ) : (
                    <CameraOff size={26} color="#ffffff" />
                  )}
                </CallButton>
                <CallButton
                  label="Retourner la caméra"
                  background={GLASS}
                  onPress={() => void flipCamera()}
                  disabled={!localCameraOn}
                  size={64}
                  delay={110}>
                  <SwitchCamera
                    size={26}
                    color={localCameraOn ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                  />
                </CallButton>
                <CallButton
                  label={muted ? 'Réactiver le micro' : 'Couper le micro'}
                  background={muted ? '#FFFFFF' : GLASS}
                  onPress={toggleMute}
                  selected={muted}
                  size={64}
                  delay={160}>
                  {muted ? <MicOff size={26} color={BG} /> : <Mic size={26} color="#ffffff" />}
                </CallButton>
              </>
            ) : (
              <>
                <CallButton
                  label={muted ? 'Réactiver le micro' : 'Couper le micro'}
                  background={muted ? '#FFFFFF' : GLASS}
                  onPress={toggleMute}
                  selected={muted}
                  size={68}
                  delay={80}>
                  {muted ? <MicOff size={27} color={BG} /> : <Mic size={27} color="#ffffff" />}
                </CallButton>
                <CallButton
                  label="Passer en vidéo"
                  background={GLASS}
                  onPress={() => void toggleCamera()}
                  size={68}
                  delay={140}>
                  <Camera size={27} color="#ffffff" />
                </CallButton>
              </>
            )}
          </View>
        </View>

        {localPipVisible && localStream ? (
          <LocalVideoPip
            streamURL={localStream.toURL()}
            mirror={facing === 'user'}
          />
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

function CallButton({
  label,
  background,
  onPress,
  children,
  delay = 0,
  selected,
  disabled,
  size = 76,
}: {
  label: string;
  background: string;
  onPress: () => void;
  children: React.ReactNode;
  delay?: number;
  selected?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <Animated.View entering={FadeInDown.delay(delay).duration(280).springify().damping(18)}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={selected === undefined ? { disabled } : { selected, disabled }}
        style={({ pressed }) => [
          styles.button,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
          disabled && styles.disabled,
          pressed && { transform: [{ scale: 0.92 }], opacity: 0.9 },
        ]}>
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  remoteVideo: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 140,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 170,
    backgroundColor: 'rgba(0,0,0,0.24)',
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
    justifyContent: 'space-between',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  cardSpacer: { height: 56 },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  cardIconOn: { backgroundColor: 'rgba(255,255,255,0.3)' },
  cardHangup: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: RED,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.94 }] },
  cardIdentity: { flex: 1, minWidth: 0 },
  cardName: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  cardStatus: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    marginTop: 1,
    fontVariant: ['tabular-nums'],
  },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatarStage: { width: 176, height: 176, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: 176,
    height: 176,
    borderRadius: 88,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  identity: { alignItems: 'center', marginTop: 30, paddingHorizontal: 16 },
  name: { color: '#ffffff', fontSize: 28, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  subtitle: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 15,
    marginTop: 8,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  weakToast: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    marginBottom: 12,
  },
  weakText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
    minHeight: 76,
  },
  incomingStack: { alignItems: 'center', gap: 14 },
  incomingRow: { flexDirection: 'row', justifyContent: 'center', gap: 56 },
  noCamera: { paddingVertical: 6, paddingHorizontal: 14 },
  noCameraText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  button: { alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.55 },
});
