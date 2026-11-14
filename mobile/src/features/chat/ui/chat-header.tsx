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
 * fond de verre, même couleur d'icônes. Le titre est aligné à gauche, sans
 * avatar, et occupe tout l'espace entre le retour et les actions.
 */
export function ChatHeaderTitle({
  title,
  subtitle,
  presenceUserId,
  onPress,
  onPressLabel,
}: {
  title: string;
  subtitle: string;
  presenceUserId?: string;
  onPress?: () => void;
  /** Libellé d'accessibilité du titre cliquable (profil du correspondant). */
  onPressLabel?: string;
}) {
  const chat = useChatColors();
  const content = (
    <View style={styles.headerTitleBody}>
      <View style={styles.headerTitleText}>
        <ThemedText
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.headerName, { color: chat.headerText }]}>
          {title}
        </ThemedText>
        {presenceUserId ? (
          <PresenceSubtitle
            userId={presenceUserId}
            onlineColor={chat.send}
            offlineColor={chat.headerSubtitle}
          />
        ) : subtitle ? (
          <ThemedText
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[styles.headerSubtitle, { color: chat.headerSubtitle }]}>
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
      accessibilityLabel={onPressLabel}
      style={styles.headerTitlePressable}>
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
  onPressTitle,
  titleAccessibilityLabel,
  right,
  blurTarget,
}: {
  title: string;
  subtitle: string;
  presenceUserId?: string;
  onPressTitle?: () => void;
  titleAccessibilityLabel?: string;
  right?: ReactNode;
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
}) {
  const chat = useChatColors();
  return (
    <Stack.Screen
      options={{
        // Le titre occupe la zone entre la flèche de retour et les actions.
        headerTitleAlign: 'left',
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
  headerTitlePressable: { flex: 1 },
  headerTitleBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    paddingLeft: Spacing.threeHalf,
    paddingRight: Spacing.two,
  },
  headerTitleText: { flex: 1, alignItems: 'flex-start', minWidth: 0 },
  headerName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '500',
    textAlign: 'left',
  },
  headerSubtitle: { fontSize: 11, lineHeight: 14, textAlign: 'left' },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    paddingRight: Spacing.two,
  },
});
