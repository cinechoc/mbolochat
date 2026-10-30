/**
 * Tokens de design MboloChat.
 *
 * Un seul endroit pour les couleurs, l'échelle typographique, les rayons et les
 * durées d'animation. Les écrans ne doivent plus écrire de valeur en dur.
 */

import '@/global.css';

import { Platform, type TextStyle } from 'react-native';

const ACCENT = '#3C87F7';

export const Colors = {
  light: {
    text: '#0B0F14',
    textSecondary: '#5B6672',
    background: '#F5F7FA',
    backgroundElement: '#FFFFFF',
    backgroundElevated: '#FFFFFF',
    backgroundSelected: '#E9EEF5',
    border: '#DFE5EC',
    accent: '#2F6FDB',
    accentSoft: '#E3EDFF',
    onAccent: '#FFFFFF',
    danger: '#D92D20',
    error: '#D92D20',
  },
  dark: {
    text: '#F2F5F8',
    textSecondary: '#8A97A8',
    background: '#0B0F14',
    backgroundElement: '#121820',
    backgroundElevated: '#1A222D',
    backgroundSelected: '#1F2936',
    border: '#1E2833',
    accent: ACCENT,
    accentSoft: '#13243D',
    onAccent: '#FFFFFF',
    danger: '#FF5A5F',
    error: '#FF5A5F',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/** Grille de 4 px. */
export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  threeHalf: 12,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/** Marges latérales d'écran. */
export const Gutter = Spacing.three;

export const Radii = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

/** Échelle typographique unique (5 tailles, 2 graisses). */
export const Type = {
  screenTitle: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  sectionTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 13, lineHeight: 18 },
  micro: { fontSize: 11, lineHeight: 15 },
} satisfies Record<string, TextStyle>;

/** Durées courtes : jamais d'animation linéaire. */
export const Motion = {
  fast: 150,
  base: 200,
  screen: 300,
  spring: { damping: 22, stiffness: 220, mass: 0.9 },
  /** Seuil de glissement qui ferme une feuille. */
  sheetDismissDistance: 120,
} as const;

/** Bouton : réduction d'échelle à l'appui. */
export const PressScale = 0.97;

/**
 * Écran d'appel (1:1 et groupe) : surface bleutée sombre, indépendante du thème
 * clair/sombre de l'application. Les valeurs n'existent qu'ici.
 */
export const CallSurface = {
  background: '#1E40AF',
  onSurface: '#FFFFFF',
  onSurfaceSoft: 'rgba(255,255,255,0.78)',
  onSurfaceFaint: 'rgba(255,255,255,0.9)',
  onSurfaceDisabled: 'rgba(255,255,255,0.35)',
  glass: 'rgba(255,255,255,0.16)',
  glassStrong: 'rgba(255,255,255,0.30)',
  card: 'rgba(0,0,0,0.32)',
  scrimTop: 'rgba(0,0,0,0.22)',
  scrimBottom: 'rgba(0,0,0,0.24)',
  toast: 'rgba(0,0,0,0.55)',
  ring: 'rgba(255,255,255,0.30)',
  hangup: '#FF3B30',
  accept: '#0BC167',
  warn: '#FFD166',
} as const;

/** Mesures propres à l'écran d'appel (boutons ronds, avatar, voiles). */
export const CallMetrics = {
  button: 76,
  buttonSmall: 64,
  buttonMedium: 68,
  hangup: 44,
  cardIcon: 36,
  avatar: 176,
  avatarSmall: 72,
  avatarCard: 40,
  cardHeight: 56,
  scrimTop: 140,
  scrimBottom: 170,
  pip: { width: 108, height: 144 },
  tileGap: Spacing.three,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
