import { useState, type ComponentRef, type RefObject } from 'react';
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
import { Glass } from './glass';
import { ThemedText } from './themed-text';
import { Colors, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Surfaces d'authentification : le texte y reste toujours clair, posé sur un
 * fond sombre (comme l'écran d'appel). Ces valeurs n'existent qu'ici ; elles
 * évitent aux trois écrans de login/register/mot de passe oublié de répéter
 * les mêmes couleurs en dur.
 */
export const AuthSurface = {
  background: Colors.dark.background,
  /** Repli opaque du verre quand le flou n'est pas disponible. */
  glassField: 'rgba(26, 34, 45, 0.92)',
  glassButton: 'rgba(26, 34, 45, 0.72)',
  border: 'rgba(255, 255, 255, 0.14)',
  text: Colors.dark.text,
  /** Texte secondaire (hints, libellés). */
  subtle: '#A3B0C0',
  /** Placeholders : plus clairs que les hints pour rester lisibles sur le verre sombre. */
  placeholder: '#AEBBCB',
  /** Liens, icônes et boutons texte posés sur la surface sombre. */
  accent: '#6FA8FF',
  /** Fond plein (bouton principal, option sélectionnée), avec texte blanc. */
  accentSolid: Colors.light.accent,
} as const;

/** Bleu solide des fonds accentués (bouton principal, option sélectionnée). */
export const accentColor = AuthSurface.accentSolid;

export type TextFieldProps = TextInputProps & {
  /** Surface en verre (écrans d'authentification). */
  glass?: boolean;
  /** Cible du flou Android : le contenu derrière le champ. */
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
};

export function TextField({
  glass = false,
  blurTarget,
  style,
  placeholderTextColor,
  ...props
}: TextFieldProps) {
  const theme = useTheme();
  const text = glass ? AuthSurface.text : theme.text;
  const placeholder =
    placeholderTextColor ?? (glass ? AuthSurface.placeholder : theme.textSecondary);
  const input = (
    <TextInput
      placeholderTextColor={placeholder}
      {...props}
      // La couleur du texte est appliquée en dernier : sur une surface en verre
      // sombre, hériter la couleur du thème clair serait illisible.
      style={[styles.input, glass && styles.transparent, style, { color: text }]}
    />
  );
  if (!glass) {
    return input;
  }
  return (
    <Glass
      appearance="dark"
      variant="clear"
      blurTarget={blurTarget}
      fallbackColor={AuthSurface.glassField}
      style={[styles.field, style]}>
      {input}
    </Glass>
  );
}

interface PasswordFieldProps extends Omit<TextInputProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Surface en verre (écrans d'authentification). */
  glass?: boolean;
  /** Cible du flou Android : le contenu derrière le champ. */
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
}

export function PasswordField({
  style,
  glass = false,
  blurTarget,
  placeholderTextColor,
  ...props
}: PasswordFieldProps) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const placeholder =
    placeholderTextColor ?? (glass ? AuthSurface.placeholder : theme.textSecondary);

  const wrapper = (
    <View style={[styles.passwordWrapper, glass && styles.transparent]}>
      <TextInput
        placeholderTextColor={placeholder}
        style={[styles.passwordInput, { color: glass ? AuthSurface.text : theme.text }]}
        secureTextEntry={!visible}
        {...props}
      />
      <Pressable
        onPress={() => setVisible((value) => !value)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
        <ThemedText type="smallBold" style={{ color: glass ? AuthSurface.accent : theme.accent }}>
          {visible ? 'Masquer' : 'Afficher'}
        </ThemedText>
      </Pressable>
    </View>
  );

  if (!glass) {
    return style ? <View style={style}>{wrapper}</View> : wrapper;
  }
  return (
    <Glass
      appearance="dark"
      variant="clear"
      blurTarget={blurTarget}
      fallbackColor={AuthSurface.glassField}
      style={[styles.field, style]}>
      {wrapper}
    </Glass>
  );
}

interface ButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  /** Surface en verre (écrans d'authentification). */
  glass?: boolean;
  /** Cible du flou Android : le contenu derrière le bouton. */
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
}

export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = 'primary',
  glass = false,
  blurTarget,
}: ButtonProps) {
  const theme = useTheme();
  const isPrimary = variant === 'primary';
  const isDisabled = disabled || loading;
  // En verre, la couleur d'accent reste visible mais posée sur la surface.
  const background = isPrimary
    ? accentColor
    : glass
      ? AuthSurface.glassButton
      : theme.backgroundElement;
  const foreground = isPrimary || glass ? Colors.dark.onAccent : theme.text;

  const pressable = (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        glass && styles.buttonGlass,
        { backgroundColor: background },
        (pressed || isDisabled) && styles.buttonPressed,
      ]}>
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <ThemedText style={{ color: foreground, fontWeight: '600' }}>{title}</ThemedText>
      )}
    </Pressable>
  );

  if (!glass) {
    return pressable;
  }
  return (
    <Glass appearance="dark" blurTarget={blurTarget} fallbackColor={background} style={styles.buttonGlass}>
      {pressable}
    </Glass>
  );
}

const styles = StyleSheet.create({
  field: {
    borderRadius: Radii.md,
    overflow: 'hidden',
  },
  buttonGlass: {
    borderRadius: Radii.md,
    overflow: 'hidden',
  },
  /** Le fond vient de la surface en verre, jamais du champ lui-même. */
  transparent: { backgroundColor: 'transparent' },
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
