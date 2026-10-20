import { ScrollView, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { ConversationFilter } from '@/lib/format';

export interface FilterOption {
  key: ConversationFilter;
  label: string;
  /** Nombre affiché à côté du libellé (absent = aucun nombre). */
  count?: number;
  /** Le compte s'affiche en pastille (et non en simple texte) : réservé aux non-lus. */
  badge?: boolean;
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
        // Seule la pastille « non lus » ressemble à un badge : les autres
        // compteurs sont affichés en texte discret pour ne pas prêter à confusion.
        const asBadge = option.badge === true && (option.count ?? 0) > 0;
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
            {option.count !== undefined && option.count > 0 ? (
              asBadge ? (
                <ThemedView style={[styles.count, { backgroundColor: accentColor }]}>
                  <ThemedText type="small" style={styles.countBadge}>
                    {option.count}
                  </ThemedText>
                </ThemedView>
              ) : (
                <ThemedText
                  type="small"
                  themeColor={active ? undefined : 'textSecondary'}
                  style={[styles.countText, active && styles.countTextActive]}>
                  {option.count}
                </ThemedText>
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
    borderRadius: 999,
  },
  label: {
    fontWeight: '600',
  },
  labelActive: {
    color: '#ffffff',
  },
  count: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: 'center',
  },
  countBadge: {
    color: '#ffffff',
    fontWeight: '700',
  },
  countText: {
    fontWeight: '600',
  },
  countTextActive: {
    color: '#ffffff',
  },
});
