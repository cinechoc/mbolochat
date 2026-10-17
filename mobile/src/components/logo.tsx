import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { accentColor } from './ui';

interface LogoMarkProps {
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function LogoMark({ size = 64, style }: LogoMarkProps) {
  const bubbleWidth = size * 0.58;
  const bubbleHeight = size * 0.44;
  const dotSize = size * 0.08;
  const tailSize = size * 0.12;

  return (
    <View
      style={[
        styles.root,
        { width: size, height: size, borderRadius: size * 0.24, backgroundColor: accentColor },
        style,
      ]}>
      <View
        style={{
          width: bubbleWidth,
          height: bubbleHeight,
          borderRadius: bubbleHeight * 0.42,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: dotSize,
        }}>
        {[0, 1, 2].map((index) => (
          <View
            key={index}
            style={{
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: accentColor,
            }}
          />
        ))}
      </View>
      <View
        style={{
          position: 'absolute',
          left: size * 0.26,
          top: size * 0.56,
          width: tailSize,
          height: tailSize,
          backgroundColor: '#ffffff',
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
