import { Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

// Source : le logo officiel de l'app (assets/images/icon.png)
const logoSource = require('../../assets/images/icon.png') as number;

interface LogoMarkProps {
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function LogoMark({ size = 64, style }: LogoMarkProps) {
  return (
    <Image
      source={logoSource}
      resizeMode="contain"
      style={[styles.logo, { width: size, height: size, borderRadius: size * 0.24 }, style]}
    />
  );
}

const styles = StyleSheet.create({
  logo: {},
});
