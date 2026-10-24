import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface AttachPanelProps {
  onPhotos: () => void;
  onCamera: () => void;
  onDocuments: () => void;
  /** Ouvre le sélecteur de stickers local dans le panneau d'expression. */
  onStickers: () => void;
}

interface PanelAction {
  key: string;
  label: string;
  icon: IoniconName;
  tint: string;
  onPress: () => void;
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
  onStickers,
}: AttachPanelProps) {
  const chat = useChatColors();
  const insets = useSafeAreaInsets();
  const actions: PanelAction[] = [
    {
      key: 'photos',
      label: 'Photos/Vidéos',
      icon: 'images-outline',
      tint: '#2F9E62',
      onPress: onPhotos,
    },
    {
      key: 'camera',
      label: 'Appareil photo',
      icon: 'camera-outline',
      tint: '#3C87F7',
      onPress: onCamera,
    },
    {
      key: 'documents',
      label: 'Fichier',
      icon: 'document-text-outline',
      tint: '#C77C2B',
      onPress: onDocuments,
    },
    {
      key: 'stickers',
      label: 'Stickers',
      icon: 'sparkles-outline',
      tint: '#8A63D2',
      onPress: onStickers,
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
        Ajouter au message
      </ThemedText>
      <View style={styles.grid}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={action.onPress}
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
    borderRadius: 17,
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
