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
  count: number;
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
            {option.count > 0 ? (
              <ThemedView
                style={[
                  styles.count,
                  { backgroundColor: active ? 'rgba(255,255,255,0.25)' : theme.background },
                ]}>
                <ThemedText
                  type="small"
                  themeColor={active ? undefined : 'textSecondary'}
                  style={active ? styles.countActive : styles.countInactive}>
                  {option.count}
                </ThemedText>
              </ThemedView>
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
  countActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  countInactive: {
    fontWeight: '700',
  },
});
