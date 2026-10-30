import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { RTCView, type MediaStream } from 'react-native-webrtc';

import { CallMetrics, CallSurface } from '@/constants/theme';

/**
 * Fond de l'écran d'appel : surface bleutée, vidéo distante plein cadre et
 * voiles haut/bas pour garder les textes lisibles par-dessus.
 */
export function CallBackdrop({
  remoteStream,
  videoVisible,
  children,
  overlay,
}: {
  remoteStream: MediaStream | null;
  videoVisible: boolean;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  const showRemote = videoVisible && Boolean(remoteStream);
  return (
    <GestureHandlerRootView style={styles.root}>
      {showRemote && remoteStream ? (
        <RTCView
          streamURL={remoteStream.toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
          zOrder={0}
        />
      ) : null}
      {showRemote ? <View pointerEvents="none" style={styles.topScrim} /> : null}
      {showRemote ? <View pointerEvents="none" style={styles.bottomScrim} /> : null}
      {children}
      {overlay}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: CallSurface.background },
  remoteVideo: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: CallMetrics.scrimTop,
    backgroundColor: CallSurface.scrimTop,
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: CallMetrics.scrimBottom,
    backgroundColor: CallSurface.scrimBottom,
  },
});
