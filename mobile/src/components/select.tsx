import { ChevronDown } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { BottomSheet } from '@/components/bottom-sheet';
import { ThemedText } from './themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface SelectOption {
  label: string;
  value: string;
}

interface SelectProps {
  placeholder: string;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  style?: StyleProp<ViewStyle>;
}

/** Choix dans une feuille du bas, comme tous les menus de l'app. */
export function Select({ placeholder, options, value, onChange, style }: SelectProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          { backgroundColor: theme.backgroundElement },
          (pressed || open) && styles.pressed,
          style,
        ]}>
        <ThemedText
          themeColor={selected ? 'text' : 'textSecondary'}
          numberOfLines={1}
          style={styles.triggerText}>
          {selected?.label ?? placeholder}
        </ThemedText>
        <ChevronDown size={16} strokeWidth={2.4} color={theme.textSecondary} />
      </Pressable>

      <BottomSheet visible={open} onClose={() => setOpen(false)} title={placeholder}>
        <FlatList
          data={options}
          keyExtractor={(item) => item.value}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const isSelected = item.value === value;
            return (
              <Pressable
                onPress={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
                style={({ pressed }) => [
                  styles.option,
                  (pressed || isSelected) && { backgroundColor: theme.backgroundSelected },
                ]}>
                <ThemedText>{item.label}</ThemedText>
              </Pressable>
            );
          }}
        />
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  triggerText: {
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.7,
  },
  option: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
});
