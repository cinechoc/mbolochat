import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { ThemedText } from './themed-text';
import { LiquidGlass } from './liquid-glass';
import { PressScale, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export const accentColor = '#3c87f7';

export function TextField({ style, ...props }: TextInputProps) {
  const theme = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.textSecondary}
      style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }, style]}
      {...props}
    />
  );
}

interface PasswordFieldProps extends Omit<TextInputProps, 'style'> {
  style?: StyleProp<ViewStyle>;
}

export function PasswordField({ style, ...props }: PasswordFieldProps) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);

  return (
    <View
      style={[styles.passwordWrapper, { backgroundColor: theme.backgroundElement }, style]}>
      <TextInput
        placeholderTextColor={theme.textSecondary}
        style={[styles.passwordInput, { color: theme.text }]}
        secureTextEntry={!visible}
        {...props}
      />
      <Pressable onPress={() => setVisible((value) => !value)} hitSlop={8}>
        <ThemedText type="smallBold" style={{ color: accentColor }}>
          {visible ? 'Masquer' : 'Afficher'}
        </ThemedText>
      </Pressable>
    </View>
  );
}

interface ButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}

export function Button({ title, onPress, loading, disabled, variant = 'primary' }: ButtonProps) {
  const theme = useTheme();
  const isPrimary = variant === 'primary';
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: isDisabled, busy: Boolean(loading) }}
      style={({ pressed }) => [
        styles.button,
        isDisabled && styles.buttonDisabled,
        pressed && !isDisabled && styles.buttonPressed,
      ]}>
      {isPrimary ? (
        <LiquidGlass radius={Radii.button} tint={accentColor} style={styles.glassFill}>
          <ButtonContent label={title} loading={loading} color={theme.text} emphasized />
        </LiquidGlass>
      ) : (
        <View
          style={[
            styles.glassFill,
            styles.plainFill,
            { backgroundColor: theme.backgroundElement, borderColor: theme.border },
          ]}>
          <ButtonContent label={title} loading={loading} color={theme.text} />
        </View>
      )}
    </Pressable>
  );
}

function ButtonContent({
  label,
  loading,
  color,
  emphasized,
}: {
  label: string;
  loading?: boolean;
  color: string;
  emphasized?: boolean;
}) {
  return (
    <View style={styles.buttonContent}>
      {loading ? <ActivityIndicator size="small" color={color} /> : null}
      <ThemedText
        style={[
          styles.buttonLabel,
          { color },
          emphasized ? styles.buttonLabelPrimary : styles.buttonLabelSecondary,
        ]}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  passwordWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  button: {
    minHeight: 56,
  },
  glassFill: {
    flex: 1,
    minHeight: 56,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  plainFill: {
    borderRadius: Radii.button,
    borderWidth: 1,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  buttonLabel: {
    fontSize: 16,
  },
  buttonLabelPrimary: {
    fontWeight: '700',
  },
  buttonLabelSecondary: {
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: PressScale }],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
