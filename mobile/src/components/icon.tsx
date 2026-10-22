import type { LucideIcon, LucideProps } from 'lucide-react-native';

type IconProps = LucideProps & { icon: LucideIcon };

/** Icône SVG avec un trait et une taille homogènes dans toute l'app. */
export function Icon({ icon: Glyph, size = 22, strokeWidth = 2.2, ...rest }: IconProps) {
  return <Glyph size={size} strokeWidth={strokeWidth} {...rest} />;
}
