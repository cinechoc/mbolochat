import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from './themed-text';
import { API_URL } from '@/lib/config';
import { initials } from '@/lib/format';

const PALETTE = ['#3c87f7', '#2f6fdb', '#5f9dfb', '#4a84e8', '#6fa8fd', '#1e5fc7'];

function paletteIndex(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) % 997;
  }
  return hash % PALETTE.length;
}

interface AvatarProps {
  name: string;
  uri?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}
export function Avatar({ name, uri, size = 52, style }: AvatarProps) {
  const imageStyle = style as any;
  const fontSize = size * 0.38;
  const fullUri = uri ? (uri.startsWith('http') ? uri : `${API_URL}${uri}`) : null;

  if (fullUri) {
    return (
      <Image
        source={{ uri: fullUri }}
        style={[{ width: size, height: size, borderRadius: size / 2 }, imageStyle]}
        contentFit="cover"
      />
    );
  }

  return (
    <View
      style={[
        styles.root,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: PALETTE[paletteIndex(name)],
        },
        style,
      ]}>
      <ThemedText
        style={{ color: '#ffffff', fontWeight: '700', fontSize, lineHeight: fontSize * 1.2 }}>
        {initials(name)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});