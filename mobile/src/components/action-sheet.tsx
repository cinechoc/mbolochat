import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { BottomSheet } from '@/components/bottom-sheet';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type SheetIcon = LucideIcon;

export interface SheetAction {
  key: string;
  label: string;
  icon?: SheetIcon;
  destructive?: boolean;
  onPress: () => void;
}

interface ActionSheetProps {
  visible: boolean;
  title?: string;
  subtitle?: string;
  /** Contenu libre au-dessus des actions (barre de réactions, par exemple). */
  header?: ReactNode;
  actions: SheetAction[];
  onClose: () => void;
}

/**
 * Feuille d'actions : toujours la même feuille du bas, sans bouton « Annuler »
 * pleine largeur. On ferme au glissement, au fond assombri, au bouton retour ou
 * à la croix.
 */
export function ActionSheet({
  visible,
  title,
  subtitle,
  header,
  actions,
  onClose,
}: ActionSheetProps) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      {header}
      {actions.map((action) => (
        <ActionRow key={action.key} action={action} onClose={onClose} />
      ))}
    </BottomSheet>
  );
}

function ActionRow({ action, onClose }: { action: SheetAction; onClose: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        onClose();
        action.onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => [
        styles.action,
        pressed && { backgroundColor: theme.backgroundSelected },
      ]}>
      {action.icon ? (
        <Icon
          icon={action.icon}
          size={20}
          color={action.destructive ? theme.danger : theme.text}
          style={styles.actionIcon}
        />
      ) : null}
      <ThemedText style={action.destructive ? { color: theme.danger } : undefined}>
        {action.label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.threeHalf,
  },
  actionIcon: {
    width: 24,
  },
});
