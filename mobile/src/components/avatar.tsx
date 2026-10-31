import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from './themed-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { API_URL } from '@/lib/config';
import { initials } from '@/lib/format';
import type { Gender } from '@/lib/types';
import { Radii } from '@/constants/theme';

const PALETTE = ['#3c87f7', '#2f6fdb', '#5f9dfb', '#4a84e8', '#6fa8fd', '#1e5fc7'];

/** Avatars mascotte, sans accessoire, avec chapeau ou avec coiffure/sac. */
const DEFAULT_AVATARS = {
  MALE: require('../../assets/images/avatars/default-male.png') as number,
  FEMALE: require('../../assets/images/avatars/default-female.png') as number,
  NEUTRAL: require('../../assets/images/avatars/default-neutral.png') as number,
};

/** Le genre ne sert qu'à choisir l'illustration ; tout le reste tombe sur le neutre. */
export function defaultAvatarSource(gender?: Gender | null): number {
  if (gender === 'MALE') {
    return DEFAULT_AVATARS.MALE;
  }
  if (gender === 'FEMALE') {
    return DEFAULT_AVATARS.FEMALE;
  }
  return DEFAULT_AVATARS.NEUTRAL;
}

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
  /** Genre du profil : MALE, FEMALE, CUSTOM ou null. */
  gender?: Gender | null;
  /** Les groupes gardent les initiales ; les utilisateurs ont la mascotte. */
  variant?: 'user' | 'group';
  /** 'circle' (défaut) ou 'rounded' : carré à coins arrondis, façon WeChat. */
  shape?: 'circle' | 'rounded';
  /** Emoji d'identité d'un groupe, affiché quand il n'y a pas de photo. */
  emoji?: string | null;
  /** Couleur de fond de l'emoji (hex). */
  color?: string | null;
}

/**
 * Avatar unique de l'app : photo si elle existe et charge, sinon mascotte
 * (selon le genre déclaré) pour un utilisateur, initiales pour un groupe.
 */
export function Avatar({
  name,
  uri,
  size = 52,
  style,
  gender,
  variant = 'user',
  shape = 'circle',
  emoji,
  color,
}: AvatarProps) {
  const scheme = useColorScheme();
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const imageStyle = style as any;
  const fontSize = size * 0.38;
  const radius = shape === 'rounded' ? Radii.md : Radii.full;
  const clip = shape === 'rounded' ? 'hidden' : undefined;
  const fullUri = uri
    ? uri.startsWith('http') || uri.startsWith('data:')
      ? uri
      : `${API_URL}${uri}`
    : null;
  const showPhoto = Boolean(fullUri && failedUri !== fullUri);

  if (showPhoto && fullUri) {
    return (
      <Image
        source={{ uri: fullUri }}
        style={[{ width: size, height: size, borderRadius: radius }, imageStyle]}
        contentFit="cover"
        onError={() => setFailedUri(fullUri)}
        accessibilityLabel={`Photo de profil de ${name}`}
      />
    );
  }

  if (variant === 'group') {
    const background = color ?? PALETTE[paletteIndex(name)];
    if (emoji) {
      return (
        <View
          style={[
            styles.root,
            {
              width: size,
              height: size,
              borderRadius: radius,
              overflow: clip,
              backgroundColor: background,
            },
            style,
          ]}
          accessibilityLabel={`Avatar du groupe ${name}`}>
          <ThemedText style={{ fontSize: size * 0.5, lineHeight: size * 0.62 }}>
            {emoji}
          </ThemedText>
        </View>
      );
    }
    return (
      <View
        style={[
          styles.root,
          {
            width: size,
            height: size,
            borderRadius: radius,
            overflow: clip,
            backgroundColor: background,
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

  return (
    <View
      style={[
        styles.root,
        styles.defaultRoot,
        {
          width: size,
          height: size,
          borderRadius: radius,
          overflow: clip,
          backgroundColor: scheme === 'dark' ? '#2A3F68' : '#E9F1FF',
        },
        style,
      ]}
      accessibilityLabel={`Avatar de ${name}`}>
      <Image
        source={defaultAvatarSource(gender)}
        style={{ width: size, height: size }}
        contentFit="cover"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultRoot: {
    overflow: 'hidden',
  },
});
