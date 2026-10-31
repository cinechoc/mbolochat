import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/bottom-sheet';
import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  /** Phrase courte affichée sous le libellé. */
  description?: string;
};

type ChoiceSheetProps<T extends string> = {
  visible: boolean;
  title: string;
  subtitle?: string;
  options: ChoiceOption<T>[];
  value: T;
  onSelect: (value: T) => void;
  onClose: () => void;
};

/** Choix exclusif dans la feuille du bas partagée, avec explication par option. */
export function ChoiceSheet<T extends string>({
  visible,
  title,
  subtitle,
  options,
  value,
  onSelect,
  onClose,
}: ChoiceSheetProps<T>) {
  const theme = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      <View style={styles.list}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => {
                onSelect(option.value);
                onClose();
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed
                    ? theme.backgroundSelected
                    : selected
                      ? theme.backgroundElement
                      : 'transparent',
                  borderColor: theme.backgroundElement,
                },
              ]}>
              <View style={styles.texts}>
                <ThemedText style={styles.label}>{option.label}</ThemedText>
                {option.description ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    {option.description}
                  </ThemedText>
                ) : null}
              </View>
              {selected ? <Check size={20} color={theme.accent} /> : null}
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.one, paddingBottom: Spacing.three },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  texts: { flex: 1, gap: 2 },
  label: { fontSize: 16, fontWeight: '600' },
});
