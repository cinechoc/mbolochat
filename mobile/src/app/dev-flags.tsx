import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import {
  setUnifiedChatFlag,
  useUnifiedChatFlag,
} from '@/features/chat/unified-flag';

/** Route de développement : inaccessible hors build de développement. */
export default function DevFlagsRoute() {
  if (!__DEV__) {
    return <Redirect href="/chats" />;
  }
  return <DevFlagsScreen />;
}

function DevFlagsScreen() {
  const enabled = useUnifiedChatFlag();
  const [saving, setSaving] = useState(false);
  const theme = useTheme();

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="sectionTitle">{fr.chat.devFlags.title}</ThemedText>
        <View style={styles.row}>
          <View style={styles.label}>
            <ThemedText>{fr.chat.devFlags.unifiedChat}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {fr.chat.devFlags.unifiedHint}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {enabled ? fr.chat.devFlags.enabled : fr.chat.devFlags.disabled}
            </ThemedText>
          </View>
          <Switch
            value={enabled}
            disabled={saving}
            accessibilityLabel={fr.chat.devFlags.unifiedChat}
            trackColor={{ true: theme.accent, false: theme.backgroundSelected }}
            onValueChange={(value) => {
              setSaving(true);
              void setUnifiedChatFlag(value).finally(() => setSaving(false));
            }}
          />
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.four, gap: Spacing.four },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  label: { flex: 1, gap: Spacing.one },
});
