import { ScrollView, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { accentColor } from '@/components/ui';
import { Spacing, Radii } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { ConversationFilter } from '@/lib/format';

export interface FilterOption {
  key: ConversationFilter;
  label: string;
  /** Nombre affiché en pastille à côté du libellé (absent ou 0 = aucune pastille). */
  count?: number;
  /** Affiche un point d'alerte au lieu du nombre : réservé aux non-lus. */
  dot?: boolean;
}

interface FilterTabsProps {
  options: FilterOption[];
  value: ConversationFilter;
  onChange: (value: ConversationFilter) => void;
}

export function FilterTabs({ options, value, onChange }: FilterTabsProps) {
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled">
      {options.map((option) => {
        const active = option.key === value;
        const count = option.count ?? 0;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={({ pressed }) => [
              styles.tab,
              {
                backgroundColor: active ? accentColor : theme.backgroundElement,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText
              type="small"
              style={[styles.label, active && styles.labelActive]}>
              {option.label}
            </ThemedText>
            {count > 0 ? (
              option.dot ? (
                <View
                  style={[styles.dot, { backgroundColor: active ? '#ffffff' : accentColor }]}
                />
              ) : (
                <View
                  style={[
                    styles.badge,
                    { backgroundColor: active ? '#ffffff' : accentColor },
                  ]}>
                  <ThemedText
                    style={[styles.badgeText, { color: active ? accentColor : '#ffffff' }]}>
                    {count > 99 ? '99+' : count}
                  </ThemedText>
                </View>
              )
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    borderRadius: Radii.sm,
  },
  label: {
    fontWeight: '600',
  },
  labelActive: {
    color: '#ffffff',
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: Radii.full,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
    marginLeft: 1,
  },
});
