import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';
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
        <ThemedText themeColor="textSecondary">▾</ThemedText>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <ThemedView style={styles.sheet}>
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
          </ThemedView>
        </Pressable>
      </Modal>
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
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  sheet: {
    width: '85%',
    maxWidth: 420,
    maxHeight: '60%',
    borderRadius: Spacing.four,
    overflow: 'hidden',
  },
  option: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
});
