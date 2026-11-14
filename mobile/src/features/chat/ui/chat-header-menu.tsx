import { MoreVertical } from 'lucide-react-native';
import { useCallback, useRef, useState, type ComponentRef } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SheetAction } from '@/components/action-sheet';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Menu d'actions de l'en-tête, ancré sous le bouton « Plus ». Il reste local à
 * l'en-tête : aucun état du menu ne remonte à la liste des messages.
 */
export function ChatHeaderMenu({
  actions,
  tintColor,
}: {
  actions: SheetAction[];
  tintColor: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const triggerRef = useRef<ComponentRef<typeof View> | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const openMenu = useCallback(() => {
    // Le menu s'ouvre même si la mesure native tarde : il retombe alors sous
    // la zone sûre, aligné à droite, puis se replace sous le bouton.
    setOpen(true);
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  }, []);

  const closeMenu = useCallback(() => setOpen(false), []);

  if (actions.length === 0) {
    return null;
  }

  const menuWidth = Math.min(280, window.width - Spacing.four);
  const top = anchor
    ? Math.max(insets.top + Spacing.two, anchor.y + anchor.height + Spacing.one)
    : insets.top + Spacing.six;
  const right = anchor
    ? Math.max(Spacing.two, window.width - anchor.x - anchor.width)
    : Spacing.two;

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openMenu}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={fr.chat.unified.moreActions}
        accessibilityState={{ expanded: open }}>
        <MoreVertical size={24} color={tintColor} />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeMenu}>
        <View style={styles.modalRoot}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeMenu}
            accessibilityRole="button"
            accessibilityLabel={fr.common.close}
          />
          <View
            accessibilityViewIsModal
            style={[
              styles.menu,
              {
                top,
                right,
                width: menuWidth,
                backgroundColor: theme.backgroundElevated,
                borderColor: theme.border,
                shadowColor: theme.text,
              },
            ]}>
            {actions.map((action) => (
              <Pressable
                key={action.key}
                onPress={() => {
                  closeMenu();
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
                <ThemedText
                  numberOfLines={1}
                  style={action.destructive ? { color: theme.danger } : undefined}>
                  {action.label}
                </ThemedText>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1 },
  menu: {
    position: 'absolute',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radii.md,
    paddingVertical: Spacing.one,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  actionIcon: { width: 24 },
});
