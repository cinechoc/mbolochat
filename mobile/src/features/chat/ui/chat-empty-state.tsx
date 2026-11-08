import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Écran vide d'une conversation (aucun message) : avatar, invitation et
 * suggestions prêtes à envoyer. Partagé pour que la conversation chiffrée
 * accueille exactement comme la conversation claire.
 */
export function ChatEmptyState({
  avatar,
  title,
  text,
  suggestions,
  onSuggestion,
}: {
  avatar: ReactNode;
  title: string;
  text: string;
  suggestions: readonly string[];
  onSuggestion: (value: string) => void;
}) {
  const theme = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.empty}>
      {avatar}
      <ThemedText type="sectionTitle" style={styles.emptyTitle}>
        {title}
      </ThemedText>
      <ThemedText type="caption" themeColor="textSecondary" style={styles.emptyText}>
        {text}
      </ThemedText>
      <View style={styles.suggestions}>
        {suggestions.map((suggestion) => (
          <Pressable
            key={suggestion}
            onPress={() => onSuggestion(suggestion)}
            accessibilityRole="button"
            accessibilityLabel={`Envoyer « ${suggestion} »`}
            style={({ pressed }) => [
              styles.suggestion,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
              pressed && { opacity: 0.7 },
            ]}>
            <ThemedText type="caption">{suggestion}</ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.two,
  },
  emptyTitle: { textAlign: 'center', marginTop: Spacing.two },
  emptyText: { textAlign: 'center' },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  suggestion: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
