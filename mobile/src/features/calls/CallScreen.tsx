import {
  AlertTriangle,
  Camera,
  CameraOff,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  SwitchCamera,
  VideoOff,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
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

import { Avatar } from '@/components/avatar';
import { CallMetrics, CallSurface, Gutter, Motion, Radii, Spacing, Type } from '@/constants/theme';
import { useCalls } from './CallProvider';
import { LocalVideoPip } from './LocalVideoPip';
import { CallActionBar, CallIncomingActions } from './ui/CallActionBar';
import { CallBackdrop } from './ui/CallBackdrop';
import { CallHeader } from './ui/CallHeader';
import { CallMembersSheet } from './ui/CallMembersSheet';
import { ParticipantGrid, type GridParticipant } from './ui/ParticipantGrid';
import { SpeakingRing } from './ui/SpeakingRing';

const BREATH_DURATION = 2200;
/** Décalage entre les deux anneaux de sonnerie. */
const RING_OFFSET = 1100;

/**
 * L'écran d'appel, unique pour le un à un et le groupe : même fond, mêmes
 * boutons, même en-tête. Seule la scène centrale change (avatar ou grille).
 */
export function CallScreen() {
  const calls = useCalls();
  const {
    status,
    mode,
    peer,
    group,
    peers,
    streams,
    speaking,
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
    self,
    media,
    maxParticipants,
    mention,
    inviteMembers,
    kickMember,
    accept,
    reject,
    hangup,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
    flipCamera,
    minimize,
  } = calls;
  const insets = useSafeAreaInsets();
  const [membersOpen, setMembersOpen] = useState(false);
  const [expandedPeerId, setExpandedPeerId] = useState<string | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const ringing = status === 'incoming' || status === 'outgoing';
  const breath = useSharedValue(0);

  useEffect(() => {
    if (!ringing) {
      cancelAnimation(breath);
      breath.value = 0;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH_DURATION, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(breath);
    };
  }, [ringing, breath]);

  const breathStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breath.value * 0.03 }],
  }));

  // En vidéo de groupe, les commandes s'effacent après quelques secondes ;
  // un appui sur l'écran les ramène.
  useEffect(() => {
    if (mode !== 'GROUP' || status !== 'active' || !videoCall || !controlsVisible) {
      return;
    }
    const timer = setTimeout(() => setControlsVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [mode, status, videoCall, controlsVisible, expandedPeerId, membersOpen]);
  const hideBar = mode === 'GROUP' && videoCall && status === 'active' && !controlsVisible;

  if (status === 'idle' || status === 'preparing' || minimized) {
    return null;
  }

  const groupMode = mode === 'GROUP';
  const name = groupMode ? (group?.name ?? 'Appel de groupe') : (peer?.displayName ?? 'Contact');
  const timing = status === 'active' && Boolean(startedAt);
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
            : timing
              ? ''
              : (endReason ?? 'Appel terminé');
  const showCard = status !== 'incoming' && status !== 'ended';
  const remoteVideoVisible =
    !groupMode && Boolean(videoCall && remoteCameraOn && remoteStream);
  // Seul en vidéo de groupe, ma caméra n'a pas de tuile : la vignette la porte.
  const pipAsSelfTile = groupMode && peers.length === 0;
  const localPipVisible = Boolean(videoCall && localCameraOn && localStream) && !pipAsSelfTile;
  const detail = groupMode
    ? `${peers.length + 1}/${maxParticipants}${media === 'VIDEO' ? ' · vidéo' : ''}`
    : __DEV__
      ? networkPath
      : null;

  const selfTile: GridParticipant = {
    id: self?.id ?? 'self',
    displayName: self?.displayName ?? 'Vous',
    avatarUrl: self?.avatarUrl ?? null,
    muted,
    connected: true,
    video: localCameraOn,
    self: true,
  };
  // En vidéo, ma caméra vit dans la vignette flottante : pas de doublon en grille.
  const tiles: GridParticipant[] = localCameraOn && peers.length > 0 ? peers : [selfTile, ...peers];

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => undefined}>
      <CallBackdrop remoteStream={remoteStream} videoVisible={remoteVideoVisible}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setControlsVisible(true)} />
        <View
          style={[
            styles.container,
            {
              paddingTop: insets.top + Spacing.two,
              paddingBottom: insets.bottom + Spacing.five - 4,
            },
          ]}>
          {showCard ? (
            <CallHeader
              title={name}
              status={statusText}
              detail={detail}
              startedAt={startedAt}
              timing={timing}
              avatar={
                groupMode ? (
                  <Avatar
                    name={name}
                    uri={group?.avatarUrl}
                    emoji={group?.emoji}
                    color={group?.color}
                    variant="group"
                    size={CallMetrics.avatarCard}
                  />
                ) : (
                  <Avatar
                    name={name}
                    uri={peer?.avatarUrl}
                    size={CallMetrics.avatarCard}
                    variant="user"
                  />
                )
              }
              onMinimize={minimize}
              onHangup={hangup}
              hangupLabel={
                groupMode
                  ? 'Quitter l’appel'
                  : status === 'active'
                    ? 'Raccrocher'
                    : 'Annuler l’appel'
              }
              speaker={{ on: speakerOn, onPress: toggleSpeaker }}
            />
          ) : (
            <View style={styles.cardSpacer} />
          )}

          {groupMode ? (
            <ParticipantGrid
              participants={tiles}
              streams={streams}
              speaking={speaking}
              expandedId={expandedPeerId}
              onExpand={(id) => {
                setExpandedPeerId(id);
                setControlsVisible(true);
              }}
              audioOnly={audioOnly}
            />
          ) : !remoteVideoVisible ? (
            <View style={styles.stage}>
              <View style={styles.avatarStage}>
                <SpeakingRing active={ringing} size={CallMetrics.avatar} />
                <SpeakingRing active={ringing} size={CallMetrics.avatar} offset={RING_OFFSET} />
                <Animated.View style={breathStyle}>
                  <Avatar
                    name={name}
                    uri={peer?.avatarUrl}
                    size={CallMetrics.avatar}
                    variant="user"
                  />
                </Animated.View>
              </View>
              {!showCard ? (
                <View style={styles.identity}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Animated.Text
                    key={statusText}
                    entering={FadeIn.duration(Motion.base)}
                    style={styles.subtitle}>
                    {statusText}
                  </Animated.Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.stage} pointerEvents="box-none" />
          )}

          {weakConnection ? (
            <Animated.View entering={FadeInDown.duration(Motion.base)} style={styles.weakToast}>
              <AlertTriangle size={15} color={CallSurface.warn} />
              <Text style={styles.weakText}>Connexion faible — caméra coupée</Text>
            </Animated.View>
          ) : null}

          <View style={[styles.bottomBar, hideBar && styles.hidden]}>
            {status === 'incoming' ? (
              <CallIncomingActions
                video={videoCall}
                onAccept={(withVideo) => void accept(withVideo)}
                onDecline={reject}
              />
            ) : status === 'ended' ? null : groupMode ? (
              <CallActionBar
                items={[
                  {
                    key: 'mic',
                    label: muted ? 'Réactiver le micro' : 'Couper le micro',
                    selected: muted,
                    size: CallMetrics.buttonSmall,
                    onPress: toggleMute,
                    icon: muted ? (
                      <MicOff size={26} color={CallSurface.background} />
                    ) : (
                      <Mic size={26} color={CallSurface.onSurface} />
                    ),
                  },
                  {
                    key: 'camera',
                    label: localCameraOn ? 'Couper la caméra' : 'Passer en vidéo',
                    selected: localCameraOn,
                    size: CallMetrics.buttonSmall,
                    onPress: () => void toggleCamera(),
                    icon: localCameraOn ? (
                      <Camera size={26} color={CallSurface.background} />
                    ) : (
                      <CameraOff size={26} color={CallSurface.onSurface} />
                    ),
                  },
                  ...(videoCall
                    ? [
                        {
                          key: 'audioOnly',
                          label: audioOnly ? 'Réafficher les vidéos' : 'Mode audio seulement',
                          selected: audioOnly,
                          size: CallMetrics.buttonSmall,
                          onPress: () => {
                            setAudioOnly((previous) => !previous);
                            setControlsVisible(true);
                          },
                          icon: <VideoOff size={24} color={audioOnly ? CallSurface.background : CallSurface.onSurface} />,
                        },
                      ]
                    : []),
                  {
                    key: 'add',
                    label: 'Inviter un membre',
                    size: CallMetrics.buttonSmall,
                    onPress: () => setMembersOpen(true),
                    icon: <Plus size={26} color={CallSurface.onSurface} />,
                  },
                  {
                    key: 'leave',
                    label: 'Quitter l’appel',
                    tone: 'hangup',
                    size: CallMetrics.buttonSmall,
                    separate: true,
                    onPress: hangup,
                    icon: <PhoneOff size={26} strokeWidth={2.2} color={CallSurface.onSurface} />,
                  },
                ]}
              />
            ) : videoCall ? (
              <CallActionBar
                items={[
                  {
                    key: 'camera',
                    label: localCameraOn ? 'Couper la caméra' : 'Activer la caméra',
                    selected: localCameraOn,
                    size: CallMetrics.buttonSmall,
                    onPress: () => void toggleCamera(),
                    icon: localCameraOn ? (
                      <Camera size={26} color={CallSurface.background} />
                    ) : (
                      <CameraOff size={26} color={CallSurface.onSurface} />
                    ),
                  },
                  {
                    key: 'flip',
                    label: 'Retourner la caméra',
                    disabled: !localCameraOn,
                    size: CallMetrics.buttonSmall,
                    onPress: () => void flipCamera(),
                    icon: (
                      <SwitchCamera
                        size={26}
                        color={
                          localCameraOn ? CallSurface.onSurface : CallSurface.onSurfaceDisabled
                        }
                      />
                    ),
                  },
                  {
                    key: 'mic',
                    label: muted ? 'Réactiver le micro' : 'Couper le micro',
                    selected: muted,
                    size: CallMetrics.buttonSmall,
                    onPress: toggleMute,
                    icon: muted ? (
                      <MicOff size={26} color={CallSurface.background} />
                    ) : (
                      <Mic size={26} color={CallSurface.onSurface} />
                    ),
                  },
                ]}
              />
            ) : (
              <CallActionBar
                items={[
                  {
                    key: 'mic',
                    label: muted ? 'Réactiver le micro' : 'Couper le micro',
                    selected: muted,
                    size: CallMetrics.buttonMedium,
                    onPress: toggleMute,
                    icon: muted ? (
                      <MicOff size={27} color={CallSurface.background} />
                    ) : (
                      <Mic size={27} color={CallSurface.onSurface} />
                    ),
                  },
                  {
                    key: 'video',
                    label: 'Passer en vidéo',
                    size: CallMetrics.buttonMedium,
                    onPress: () => void toggleCamera(),
                    icon: <Camera size={27} color={CallSurface.onSurface} />,
                  },
                ]}
              />
            )}
          </View>
        </View>

        {mention ? (
          <Animated.View entering={FadeIn.duration(Motion.fast)} style={styles.mention}>
            <Text style={styles.mentionText}>{mention}</Text>
          </Animated.View>
        ) : null}

        {localPipVisible && localStream ? (
          <LocalVideoPip streamURL={localStream.toURL()} mirror={facing === 'user'} />
        ) : null}

        <CallMembersSheet
          visible={membersOpen}
          onClose={() => setMembersOpen(false)}
          conversationId={group?.conversationId ?? null}
          participants={peers}
          onInvite={inviteMembers}
          onKick={kickMember}
        />
      </CallBackdrop>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Gutter,
    justifyContent: 'space-between',
  },
  cardSpacer: { height: CallMetrics.cardHeight },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatarStage: {
    width: CallMetrics.avatar,
    height: CallMetrics.avatar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identity: { alignItems: 'center', marginTop: Spacing.five, paddingHorizontal: Gutter },
  name: {
    ...Type.screenTitle,
    fontSize: 28,
    lineHeight: 34,
    color: CallSurface.onSurface,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  subtitle: {
    ...Type.body,
    color: CallSurface.onSurfaceSoft,
    marginTop: Spacing.two,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  weakToast: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.threeHalf,
    borderRadius: Radii.lg,
    backgroundColor: CallSurface.toast,
    marginBottom: Spacing.threeHalf,
  },
  weakText: { ...Type.caption, color: CallSurface.onSurface, fontWeight: '600' },
  bottomBar: { alignItems: 'center', minHeight: CallMetrics.button },
  hidden: { opacity: 0 },
  mention: {
    alignSelf: 'center',
    marginBottom: Spacing.two,
    paddingHorizontal: Spacing.threeHalf,
    paddingVertical: Spacing.one + 2,
    borderRadius: Radii.pill,
    backgroundColor: CallSurface.card,
  },
  mentionText: { ...Type.micro, color: CallSurface.onSurfaceSoft },
});
