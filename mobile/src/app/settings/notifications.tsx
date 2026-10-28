import { Redirect, Stack, useFocusEffect } from 'expo-router';
import {
  BatteryCharging,
  Bell,
  ExternalLink,
  Eye,
  Maximize2,
  Smartphone,
  Volume2,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { conversationTitle } from '@/lib/format';
import {
  getPushPermissionStatus,
  openBatteryOptimizationSettings,
  openFullScreenIntentSettings,
  requestPushToken,
} from '@/lib/push';
import type { ConversationSummary } from '@/lib/types';

/** Réglages des notifications : interrupteur global + silence par discussion. */
export default function NotificationSettingsScreen() {
  const { token, user, setUser } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [pushStatus, setPushStatus] = useState<'granted' | 'denied' | 'undetermined'>(
    'undetermined',
  );
  const [error, setError] = useState<string | null>(null);

  // Extrait avant le useCallback : le compilateur React n'accepte pas un
  // membre optionnel dans la liste de dépendances.
  const notificationsEnabled = user?.notificationsEnabled ?? false;

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const list = await api.listConversations(token);
      setConversations(list);
      const status = await getPushPermissionStatus();
      setPushStatus(status);
      // Permission déjà accordée (par exemple depuis les réglages Android) :
      // on enregistre le jeton sans redemander quoi que ce soit.
      if (status === 'granted' && notificationsEnabled) {
        const pushToken = await requestPushToken();
        if (pushToken) {
          await api.registerPushToken(token, pushToken);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger les discussions.');
    }
  }, [token, notificationsEnabled]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  const toggleGlobal = async (value: boolean) => {
    try {
      const updated = await api.setNotificationsEnabled(token, value);
      setUser(updated);
      if (value) {
        // Activer les notifications push : permission + enregistrement du jeton.
        const pushToken = await requestPushToken();
        if (pushToken) {
          await api.registerPushToken(token, pushToken);
        }
        setPushStatus(await getPushPermissionStatus());
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement impossible.');
    }
  };

  const updatePreferences = async (patch: {
    notificationSound?: boolean;
    notificationPreview?: boolean;
  }) => {
    try {
      setUser(await api.setNotificationPreferences(token, patch));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement impossible.');
    }
  };

  const toggleMute = async (conversation: ConversationSummary, value: boolean) => {
    try {
      const updated = await api.setConversationPreferences(token, conversation.id, {
        muted: !value,
      });
      setConversations((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement impossible.');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.four }}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          DANS L&apos;APPLICATION
        </ThemedText>
        <ThemedView style={styles.group}>
          <View style={[styles.row, { borderBottomColor: theme.backgroundElement }]}>
            <Bell size={22} color={theme.text} />
            <ThemedText style={styles.rowLabel}>Notifications</ThemedText>
            <Switch
              value={user.notificationsEnabled}
              onValueChange={(value) => void toggleGlobal(value)}
              trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
            />
          </View>
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          Quand cette option est désactivée, MboloChat n&apos;affiche plus les pastilles de messages
          non lus.
        </ThemedText>

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          NOTIFICATIONS APPAREIL
        </ThemedText>
        <ThemedView style={styles.group}>
          <View style={[styles.row, { borderBottomColor: theme.backgroundElement }]}>
            <Smartphone size={22} color={theme.text} />
            <ThemedText style={styles.rowLabel}>Notifications push</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {pushStatus === 'granted'
                ? 'Activées'
                : pushStatus === 'denied'
                  ? 'Refusées'
                  : 'Non activées'}
            </ThemedText>
          </View>
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          {pushStatus === 'granted'
            ? 'MboloChat peut te prévenir même quand l’application est fermée.'
            : pushStatus === 'denied'
              ? 'Android bloque les notifications de MboloChat. Autorise-les dans les réglages du téléphone.'
              : 'Active l’option « Notifications » ci-dessus pour autoriser MboloChat à t’avertir même quand l’application est fermée.'}
        </ThemedText>
        {pushStatus === 'denied' ? (
          <Pressable
            onPress={() => void Linking.openSettings()}
            style={({ pressed }) => [
              styles.linkButton,
              pressed ? { backgroundColor: theme.backgroundSelected } : null,
            ]}>
            <ThemedText type="smallBold" style={styles.linkLabel}>
              Ouvrir les réglages Android
            </ThemedText>
            <ExternalLink size={16} color="#3c87f7" />
          </Pressable>
        ) : null}

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          PRÉFÉRENCES
        </ThemedText>
        <ThemedView style={styles.group}>
          <View style={[styles.row, { borderBottomColor: theme.backgroundElement }]}>
            <Volume2 size={22} color={theme.text} />
            <ThemedText style={styles.rowLabel}>Sons</ThemedText>
            <Switch
              value={user.notificationSound ?? true}
              onValueChange={(value) => void updatePreferences({ notificationSound: value })}
              trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
            />
          </View>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Eye size={22} color={theme.text} />
            <ThemedText style={styles.rowLabel}>Aperçus</ThemedText>
            <Switch
              value={user.notificationPreview ?? true}
              onValueChange={(value) => void updatePreferences({ notificationPreview: value })}
              trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
            />
          </View>
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          Aperçus désactivés : les notifications affichent « Nouveau message » au lieu du texte.
        </ThemedText>

        {Platform.OS === 'android' ? (
          <>
            <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
              ARRIÈRE-PLAN
            </ThemedText>
            <ThemedView style={styles.group}>
              <Pressable
                onPress={openBatteryOptimizationSettings}
                style={[styles.row, { borderBottomColor: theme.backgroundElement }]}>
                <BatteryCharging size={22} color={theme.text} />
                <ThemedText style={styles.rowLabel}>Optimisation de batterie</ThemedText>
                <ExternalLink size={16} color={theme.textSecondary} />
              </Pressable>
              <Pressable
                onPress={openFullScreenIntentSettings}
                style={[styles.row, { borderBottomWidth: 0 }]}>
                <Maximize2 size={22} color={theme.text} />
                <ThemedText style={styles.rowLabel}>Appels plein écran</ThemedText>
                <ExternalLink size={16} color={theme.textSecondary} />
              </Pressable>
            </ThemedView>
            <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
              Autorise MboloChat à rester actif en arrière-plan pour recevoir les appels et les
              messages sans délai, et à afficher les appels sur l’écran verrouillé.
            </ThemedText>
          </>
        ) : null}

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          PAR DISCUSSION
        </ThemedText>
        {conversations.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
            Aucune discussion pour le moment.
          </ThemedText>
        ) : (
          <ThemedView style={styles.group}>
            {conversations.map((conversation, index) => {
              const title = conversationTitle(conversation, user.id);
              const isGroup = conversation.type === 'GROUP';
              const other = isGroup
                ? undefined
                : conversation.members.find((member) => member.id !== user.id);
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => void toggleMute(conversation, !conversation.muted)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      borderBottomColor: theme.backgroundElement,
                      borderBottomWidth: index === conversations.length - 1 ? 0 : undefined,
                    },
                    pressed ? { backgroundColor: theme.backgroundSelected } : null,
                  ]}>
                  <Avatar
                    name={title}
                    size={36}
                    uri={isGroup ? null : other?.avatarUrl}
                    gender={other?.gender}
                    variant={isGroup ? 'group' : 'user'}
                  />
                  <ThemedText style={styles.rowLabel} numberOfLines={1}>
                    {title}
                  </ThemedText>
                  <Switch
                    value={!conversation.muted}
                    onValueChange={(value) => void toggleMute(conversation, value)}
                    trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
                  />
                </Pressable>
              );
            })}
          </ThemedView>
        )}

        {error ? (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sectionTitle: {
    letterSpacing: 0.8,
    marginTop: Spacing.three,
    marginBottom: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
  group: {
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
  },
  hint: {
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.one,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    alignSelf: 'flex-start',
    marginTop: Spacing.two,
    marginLeft: Spacing.three,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: 8,
  },
  linkLabel: {
    color: '#3c87f7',
  },
  error: {
    color: '#e5484d',
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.three,
  },
});
