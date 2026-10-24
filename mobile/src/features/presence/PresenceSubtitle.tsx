import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';

import { formatLastSeen } from './formatLastSeen';
import { presenceNow, usePresence } from './usePresence';

interface PresenceSubtitleProps {
  userId: string;
  onlineColor: string;
  offlineColor: string;
}

const TICK_MS = 30_000;

/**
 * Seul ce petit composant se re-rend toutes les 30 s : ni la conversation, ni
 * la liste des messages ne sont touchées par le rafraîchissement du « vu… ».
 */
export function PresenceSubtitle({ userId, onlineColor, offlineColor }: PresenceSubtitleProps) {
  const [focused, setFocused] = useState(true);
  const [now, setNow] = useState(() => presenceNow());
  const presence = usePresence(userId, focused);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setNow(presenceNow());
      const timer = setInterval(() => setNow(presenceNow()), TICK_MS);
      return () => {
        setFocused(false);
        clearInterval(timer);
      };
    }, []),
  );

  const label = useMemo(() => {
    if (!focused) return '';
    if (presence.state === 'online') return 'en ligne';
    if (presence.state === 'offline' && presence.lastSeenAt) {
      return formatLastSeen(presence.lastSeenAt, now);
    }
    return '';
  }, [focused, now, presence.lastSeenAt, presence.state]);

  return (
    <View style={styles.line}>
      {label ? (
        <Animated.View key={`${presence.state}:${label}`} entering={FadeIn.duration(150)}>
          <ThemedText
            numberOfLines={1}
            style={[
              styles.text,
              { color: presence.state === 'online' ? onlineColor : offlineColor },
            ]}>
            {label}
          </ThemedText>
        </Animated.View>
      ) : (
        <ThemedText style={[styles.text, styles.placeholder]}> </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    height: 14,
    justifyContent: 'center',
  },
  text: {
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  placeholder: {
    opacity: 0,
  },
});
