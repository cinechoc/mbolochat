import { Colors } from '@/constants/theme';
import { useThemePreference } from '@/lib/theme-preference';

export function useTheme() {
  const { scheme } = useThemePreference();
  return Colors[scheme];
}
