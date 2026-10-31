import { StyleSheet, View } from 'react-native';

import { usePresence } from './usePresence';
import { Radii } from '@/constants/theme';

/** Point vert de la liste des discussions ; aucun texte ni état hors ligne. */
export function PresenceDot({ userId }: { userId: string }) {
  const presence = usePresence(userId);
  if (presence.state !== 'online') return null;
  return <View style={styles.dot} />;
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 10,
    height: 10,
    borderRadius: Radii.full,
    borderWidth: 2,
    borderColor: '#ffffff',
    backgroundColor: '#07C160',
  },
});
