import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Identité de repli d'un groupe : un emoji et une couleur, sans photo. */
export const GROUP_EMOJIS = [
  '💬',
  '🎉',
  '🏀',
  '⚽',
  '🎮',
  '🎵',
  '🍕',
  '🌴',
  '🚀',
  '🐱',
  '🐶',
  '🦁',
  '🔥',
  '⭐',
  '🌈',
  '☕',
  '💼',
  '📚',
  '🎓',
  '🏠',
  '❤️',
  '🎂',
  '🧠',
  '🛹',
] as const;

export const GROUP_COLORS = [
  '#3c87f7',
  '#2f6fdb',
  '#7c5cff',
  '#d946ef',
  '#e04f5f',
  '#f2994a',
  '#2fbf71',
  '#0ea5a5',
  '#8e6b4a',
  '#475569',
] as const;

interface EmojiColorPickerProps {
  emoji: string;
  color: string;
  onChangeEmoji: (emoji: string) => void;
  onChangeColor: (color: string) => void;
}

export function EmojiColorPicker({
  emoji,
  color,
  onChangeEmoji,
  onChangeColor,
}: EmojiColorPickerProps) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <ThemedText type="small" themeColor="textSecondary">
        Emoji du groupe
      </ThemedText>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {GROUP_EMOJIS.map((entry) => (
          <Pressable
            key={entry}
            onPress={() => onChangeEmoji(entry)}
            accessibilityRole="button"
            accessibilityLabel={`Emoji ${entry}`}
            style={[
              styles.emojiCell,
              { backgroundColor: theme.backgroundElement },
              entry === emoji && { borderColor: color, borderWidth: 2 },
            ]}>
            <ThemedText style={styles.emoji}>{entry}</ThemedText>
          </Pressable>
        ))}
      </ScrollView>

      <ThemedText type="small" themeColor="textSecondary">
        Couleur
      </ThemedText>
      <View style={styles.row}>
        {GROUP_COLORS.map((entry) => (
          <Pressable
            key={entry}
            onPress={() => onChangeColor(entry)}
            accessibilityRole="button"
            accessibilityLabel={`Couleur ${entry}`}
            style={[
              styles.colorDot,
              { backgroundColor: entry },
              entry === color && { borderColor: theme.text, borderWidth: 3 },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.one },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, paddingVertical: Spacing.one },
  emojiCell: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 22, lineHeight: 28 },
  colorDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderColor: 'transparent',
  },
});
