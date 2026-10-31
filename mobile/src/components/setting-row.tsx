import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type SettingRowProps = {
  icon?: LucideIcon;
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Interrupteur : la ligne entière bascule, l'interrupteur reste visuel. */
  toggle?: { value: boolean; onChange: (value: boolean) => void };
  style?: StyleProp<ViewStyle>;
};

/** Ligne de réglage unique : icône, libellé, valeur, chevron ou interrupteur. */
export function SettingRow({
  icon,
  label,
  value,
  onPress,
  destructive,
  disabled,
  toggle,
  style,
}: SettingRowProps) {
  const theme = useTheme();
  const pressable = Boolean(onPress) || Boolean(toggle);
  const color = destructive ? '#e5484d' : theme.text;

  return (
    <Pressable
      onPress={toggle ? () => toggle.onChange(!toggle.value) : onPress}
      disabled={!pressable || disabled}
      accessibilityRole={toggle ? 'switch' : pressable ? 'button' : 'text'}
      accessibilityState={toggle ? { checked: toggle.value, disabled } : { disabled }}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.backgroundElement },
        pressed && pressable ? { backgroundColor: theme.backgroundSelected } : null,
        disabled && styles.disabled,
        style,
      ]}>
      {icon ? <Icon icon={icon} size={22} color={color} /> : null}
      <ThemedText style={[styles.label, { color }]} numberOfLines={3}>
        {label}
      </ThemedText>
      {value ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.value}>
          {value}
        </ThemedText>
      ) : null}
      {toggle ? (
        <View pointerEvents="none">
          <Switch
            value={toggle.value}
            trackColor={{ false: theme.backgroundElement, true: '#3c87f7' }}
            thumbColor="#ffffff"
          />
        </View>
      ) : pressable ? (
        <ChevronRight size={18} color={theme.textSecondary} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 44,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: Radii.md,
  },
  label: { flex: 1, fontSize: 16 },
  value: { maxWidth: '45%', textAlign: 'right' },
  disabled: { opacity: 0.45 },
});
