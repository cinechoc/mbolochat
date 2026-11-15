import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, memo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing, Radii } from '@/constants/theme';
import { fr } from '@/i18n/fr';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface AttachPanelProps {
  onPhotos: () => void;
  onCamera: (mode: 'photo' | 'video') => void;
  onDocuments: () => void;
}

interface PanelAction {
  key: string;
  label: string;
  icon: IoniconName;
  tint: string;
  onPress: () => void;
  onLongPress?: () => void;
  hint?: string;
}

/**
 * Panneau « + » : uniquement des actions réellement branchées.
 * Chaque tuile garde la même taille pour que la grille reste alignée sur une
 * ligne, y compris sur les petits écrans.
 */
export const AttachPanel = memo(function AttachPanel({
  onPhotos,
  onCamera,
  onDocuments,
}: AttachPanelProps) {
  const chat = useChatColors();
  const insets = useSafeAreaInsets();
  const longPressUntil = useRef<Record<string, number>>({});
  const actions: PanelAction[] = [
    {
      key: 'photos',
      label: fr.chat.attach.photos,
      icon: 'images-outline',
      tint: '#2F9E62',
      onPress: onPhotos,
    },
    {
      key: 'camera',
      label: fr.chat.attach.camera,
      icon: 'camera-outline',
      tint: '#3C87F7',
      onPress: () => onCamera('photo'),
      onLongPress: () => onCamera('video'),
      hint: fr.chat.attach.cameraVideoHint,
    },
    {
      key: 'documents',
      label: fr.chat.attach.documents,
      icon: 'document-text-outline',
      tint: '#C77C2B',
      onPress: onDocuments,
    },
  ];

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: chat.composer,
          borderTopColor: chat.border,
          paddingBottom: Math.max(insets.bottom, Spacing.three),
        },
      ]}>
      <ThemedText type="small" style={[styles.caption, { color: chat.secondaryText }]}>
        {fr.chat.attach.title}
      </ThemedText>
      <View style={styles.grid}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={action.hint}
            onLongPress={
              action.onLongPress
                ? () => {
                    longPressUntil.current[action.key] = Date.now() + 1500;
                    action.onLongPress?.();
                  }
                : undefined
            }
            delayLongPress={380}
            onPress={() => {
              if ((longPressUntil.current[action.key] ?? 0) > Date.now()) return;
              action.onPress();
            }}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
            <View style={[styles.iconTile, { backgroundColor: `${action.tint}22` }]}>
              <Ionicons name={action.icon} size={27} color={action.tint} />
            </View>
            <ThemedText
              numberOfLines={2}
              style={[styles.label, { color: chat.secondaryText }]}>
              {action.label}
            </ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.two,
  },
  caption: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
    fontSize: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  item: {
    width: '25%',
    alignItems: 'center',
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.96 }],
  },
  iconTile: {
    width: 58,
    height: 58,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    width: '100%',
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
  },
});
