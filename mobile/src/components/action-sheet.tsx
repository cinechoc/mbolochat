import type { LucideIcon } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
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
  actions: SheetAction[];
  onClose: () => void;
  /** 'sheet' (bas d'écran, défaut) ou 'center' (carte modale centrée). */
  variant?: 'sheet' | 'center';
}

/** Feuille d'actions (bas d'écran ou carte centrée), façon WhatsApp. */
export function ActionSheet({
  visible,
  title,
  subtitle,
  actions,
  onClose,
  variant = 'sheet',
}: ActionSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const centered = variant === 'center';

  return (
    <Modal
      visible={visible}
      transparent
      animationType={centered ? 'fade' : 'slide'}
      onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, centered && styles.backdropCenter]} onPress={onClose}>
        <Pressable
          onPress={() => undefined}
          style={[
            styles.sheet,
            centered ? styles.card : styles.sheetBottom,
            {
              backgroundColor: theme.background,
              borderColor: theme.backgroundElement,
              paddingBottom: centered ? Spacing.two : Math.max(insets.bottom, Spacing.three),
            },
          ]}>
          {title ? (
            <ThemedView style={[styles.header, centered && styles.headerCenter]}>
              <ThemedText type="smallBold" numberOfLines={1}>
                {title}
              </ThemedText>
              {subtitle ? (
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  numberOfLines={centered ? 3 : 1}>
                  {subtitle}
                </ThemedText>
              ) : null}
            </ThemedView>
          ) : null}
          <View style={[styles.divider, { backgroundColor: theme.backgroundElement }]} />
          {actions.map((action) => (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              style={({ pressed }) => [
                styles.action,
                pressed && { backgroundColor: theme.backgroundSelected },
              ]}>
              {action.icon ? (
                <Icon
                  icon={action.icon}
                  size={20}
                  color={action.destructive ? '#e5484d' : theme.text}
                  style={styles.actionIcon}
                />
              ) : null}
              <ThemedText style={action.destructive ? styles.destructive : undefined}>
                {action.label}
              </ThemedText>
            </Pressable>
          ))}
          {centered ? (
            <>
              <View style={[styles.divider, { backgroundColor: theme.backgroundElement }]} />
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Annuler"
                style={({ pressed }) => [
                  styles.action,
                  styles.cancel,
                  pressed && { backgroundColor: theme.backgroundSelected },
                ]}>
                <ThemedText type="smallBold">Annuler</ThemedText>
              </Pressable>
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end',
  },
  backdropCenter: {
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
  },
  sheet: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  sheetBottom: {
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderRadius: Spacing.four,
    overflow: 'hidden',
    elevation: 12,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    gap: Spacing.half,
  },
  headerCenter: {
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: Spacing.one,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  actionIcon: {
    width: 24,
  },
  cancel: {
    justifyContent: 'center',
  },
  destructive: {
    color: '#e5484d',
    fontWeight: '600',
  },
});
