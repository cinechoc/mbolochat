import { Stack } from 'expo-router';
import type { ComponentRef, ReactNode, RefObject } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Glass } from '@/components/glass';
import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { PresenceSubtitle } from '@/features/presence/PresenceSubtitle';

/**
 * En-tête de conversation partagé : mêmes marges, mêmes tailles de texte, même
 * fond de verre, même couleur d'icônes. L'écran classique y ajoute l'avatar de
 * groupe, la présence et les appels ; l'écran chiffré y met son cadenas.
 */
export function ChatHeaderTitle({
  title,
  subtitle,
  presenceUserId,
  avatar,
  onPress,
  onPressLabel,
}: {
  title: string;
  subtitle: string;
  presenceUserId?: string;
  avatar?: ReactNode;
  onPress?: () => void;
  /** Libellé d'accessibilité du titre cliquable (profil du correspondant). */
  onPressLabel?: string;
}) {
  const chat = useChatColors();
  const content = (
    <View style={styles.headerTitleBody}>
      {avatar}
      <View style={styles.headerTitleText}>
        <ThemedText numberOfLines={1} style={[styles.headerName, { color: chat.headerText }]}>
          {title}
        </ThemedText>
        {presenceUserId ? (
          <PresenceSubtitle
            userId={presenceUserId}
            onlineColor={chat.send}
            offlineColor={chat.headerSubtitle}
          />
        ) : subtitle ? (
          <ThemedText numberOfLines={1} style={[styles.headerSubtitle, { color: chat.headerSubtitle }]}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole={onPressLabel ? 'button' : undefined}
      accessibilityLabel={onPressLabel}>
      {content}
    </Pressable>
  );
}

/**
 * Déclare l'en-tête de l'écran de conversation (verre + titre + actions).
 * Rend un `<Stack.Screen>` : à monter une fois par écran.
 */
export function ChatHeaderScreen({
  title,
  subtitle,
  presenceUserId,
  avatar,
  onPressTitle,
  titleAccessibilityLabel,
  right,
  blurTarget,
}: {
  title: string;
  subtitle: string;
  presenceUserId?: string;
  avatar?: ReactNode;
  onPressTitle?: () => void;
  titleAccessibilityLabel?: string;
  right?: ReactNode;
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
}) {
  const chat = useChatColors();
  return (
    <Stack.Screen
      options={{
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerTintColor: chat.headerText,
        // Fond verre : le contenu défile dessous, le flou le masque sans le cacher.
        headerBackground: () => (
          <Glass
            blurTarget={blurTarget}
            fallbackColor={chat.screen}
            style={styles.headerBackground}
          />
        ),
        headerTitle: () => (
          <ChatHeaderTitle
            title={title}
            subtitle={subtitle}
            presenceUserId={presenceUserId}
            avatar={avatar}
            onPress={onPressTitle}
            onPressLabel={titleAccessibilityLabel}
          />
        ),
        headerRight: right ? () => <View style={styles.headerRight}>{right}</View> : undefined,
      }}
    />
  );
}

const styles = StyleSheet.create({
  headerBackground: { flex: 1 },
  headerTitleBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    maxWidth: 240,
  },
  headerTitleText: { flexShrink: 1, alignItems: 'center' },
  headerName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '500',
    textAlign: 'center',
  },
  headerSubtitle: { fontSize: 11, lineHeight: 14, textAlign: 'center' },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingRight: Spacing.two,
  },
});
