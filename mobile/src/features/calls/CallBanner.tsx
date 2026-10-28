import { ChevronUp, MicOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { useCalls } from './CallProvider';

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Appel réduit : bannière flottante au-dessus de l'app. Un appui rouvre
 * l'écran d'appel plein écran.
 */
export function CallBanner() {
  const { status, peer, muted, startedAt, minimized, restore } = useCalls();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (status !== 'active' || !startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [status, startedAt]);

  if (!minimized || status === 'idle' || status === 'ended') {
    return null;
  }

  const name = peer?.displayName ?? 'Contact';
  const subtitle =
    status === 'active' && startedAt
      ? formatDuration(now - startedAt)
      : status === 'reconnecting'
        ? 'Reconnexion…'
        : status === 'connecting'
          ? 'Connexion…'
          : 'Appelle…';

  return (
    <View style={[styles.layer, { top: insets.top + 8 }]} pointerEvents="box-none">
      <Animated.View entering={FadeInDown.duration(220).springify().damping(18)}>
        <Pressable
          onPress={restore}
          accessibilityRole="button"
          accessibilityLabel={`Revenir à l’appel avec ${name}`}
          style={({ pressed }) => [styles.banner, pressed && styles.pressed]}>
          <Avatar name={name} uri={peer?.avatarUrl} size={34} variant="user" />
          <View style={styles.texts}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <View style={styles.statusRow}>
              {muted ? <MicOff size={11} strokeWidth={2.4} color="#9BA3B5" /> : null}
              <Text style={styles.status} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
          </View>
          <ChevronUp size={20} strokeWidth={2.4} color="#C9CFDA" />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 1000,
    elevation: 12,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: 26,
    backgroundColor: '#171A22',
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  pressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  texts: { flex: 1, minWidth: 0 },
  name: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  status: {
    color: '#9BA3B5',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
});
