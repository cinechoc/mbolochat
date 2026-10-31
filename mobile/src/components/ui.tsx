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
import { Spacing, Radii } from '@/constants/theme';
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
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: isPrimary ? accentColor : theme.backgroundElement },
        (pressed || isDisabled) && styles.buttonPressed,
      ]}>
      {loading ? (
        <ActivityIndicator color={isPrimary ? '#ffffff' : theme.text} />
      ) : (
        <ThemedText style={{ color: isPrimary ? '#ffffff' : theme.text, fontWeight: '600' }}>
          {title}
        </ThemedText>
      )}
    </Pressable>
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
    borderRadius: Radii.md,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: {
    opacity: 0.6,
  },
});
