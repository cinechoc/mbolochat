import { Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

// Version 256 px du logo officiel, suffisante pour les tailles d'interface.
const logoSource = require('../../assets/images/logo-mark.png') as number;

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
