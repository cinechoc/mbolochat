import { StyleSheet, Text } from 'react-native';

import { CallSurface, Type } from '@/constants/theme';
import { formatCallDuration, useElapsed } from '../hooks/useElapsed';

/**
 * Minuteur d'appel isolé : c'est le seul composant qui se re-rend au tic,
 * jamais l'écran d'appel entier.
 */
export function CallTimer({
  startedAt,
  active,
  style,
}: {
  startedAt: number | null;
  active: boolean;
  style?: object;
}) {
  const elapsedMs = useElapsed(startedAt, active);
  return (
    <Text style={[styles.text, style]} numberOfLines={1}>
      {formatCallDuration(elapsedMs)}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    ...Type.caption,
    color: CallSurface.onSurfaceSoft,
    fontVariant: ['tabular-nums'],
  },
});
