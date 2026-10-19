import { MaterialIcons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type SheetIcon = React.ComponentProps<typeof MaterialIcons>['name'];

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
}

/** Feuille d'actions (bas d'écran), façon WhatsApp. */
export function ActionSheet({ visible, title, subtitle, actions, onClose }: ActionSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          onPress={() => undefined}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.background,
              borderColor: theme.backgroundElement,
              paddingBottom: Math.max(insets.bottom, Spacing.three),
            },
          ]}>
          {title ? (
            <ThemedView style={styles.header}>
              <ThemedText type="smallBold" numberOfLines={1}>
                {title}
              </ThemedText>
              {subtitle ? (
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
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
                <MaterialIcons
                  name={action.icon}
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
  sheet: {
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    gap: Spacing.half,
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
  destructive: {
    color: '#e5484d',
    fontWeight: '600',
  },
});
