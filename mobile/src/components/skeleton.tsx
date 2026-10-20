import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Squelettes de chargement.
 *
 * WhatsApp n'affiche jamais de spinner plein écran : la structure de la page
 * apparaît immédiatement, avec des blocs gris qui respirent le temps que les
 * données arrivent. On fait pareil.
 */

function usePulse() {
  const [pulse] = useState(() => new Animated.Value(0.45));

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.9,
          duration: 650,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 650,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return pulse;
}

interface SkeletonBlockProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}

/** Bloc gris qui pulse (ligne de texte, bouton…). */
export function SkeletonBlock({ width = '100%', height = 12, radius = 6, style }: SkeletonBlockProps) {
  const theme = useTheme();
  const pulse = usePulse();

  return (
    <Animated.View
      style={[
        styles.block,
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: theme.backgroundElement,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

/** Avatar fantôme (cercle qui pulse). */
export function SkeletonAvatar({ size = 86 }: { size?: number }) {
  const theme = useTheme();
  const pulse = usePulse();

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.backgroundElement,
        opacity: pulse,
      }}
    />
  );
}

/** En-tête de profil fantôme. */
export function SkeletonProfile() {
  return (
    <View style={styles.profile}>
      <View style={styles.profileTop}>
        <SkeletonAvatar size={86} />
        <View style={styles.profileInfo}>
          <SkeletonBlock width="55%" height={16} />
          <SkeletonBlock width="40%" height={12} />
          <SkeletonBlock width="70%" height={12} />
          <SkeletonBlock width={120} height={32} radius={8} style={styles.profileButton} />
        </View>
      </View>
    </View>
  );
}

/** Lignes de liste fantômes (utilisées par la liste des discussions). */
export function SkeletonRows({ count = 6, avatarSize = 52 }: { count?: number; avatarSize?: number }) {
  return (
    <View style={styles.rows}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.row}>
          <SkeletonAvatar size={avatarSize} />
          <View style={styles.rowBody}>
            <SkeletonBlock width="45%" height={13} />
            <SkeletonBlock width="70%" height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Bulles de message fantômes. */
export function SkeletonBubbles({ count = 6 }: { count?: number }) {
  return (
    <View style={styles.bubbles}>
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          style={[styles.bubbleRow, index % 2 === 0 ? styles.bubbleRight : styles.bubbleLeft]}>
          <SkeletonBlock width={index % 2 === 0 ? 120 : 180} height={38} radius={18} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {},
  profile: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
  },
  profileTop: {
    flexDirection: 'row',
    gap: Spacing.four,
  },
  profileInfo: {
    flex: 1,
    gap: Spacing.two,
  },
  profileButton: {
    marginTop: Spacing.one,
  },
  rows: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  rowBody: {
    flex: 1,
    gap: Spacing.one,
  },
  bubbles: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
    paddingTop: Spacing.three,
  },
  bubbleRow: {
    flexDirection: 'row',
  },
  bubbleLeft: {
    justifyContent: 'flex-start',
  },
  bubbleRight: {
    justifyContent: 'flex-end',
  },
});
