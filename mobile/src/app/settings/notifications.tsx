import { Redirect, Stack, useFocusEffect } from 'expo-router';
import {
  BatteryCharging,
  Bell,
  CircleUserRound,
  ExternalLink,
  Maximize2,
  MessageSquare,
  Moon,
  Phone,
  Smartphone,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ChoiceSheet, type ChoiceOption } from '@/components/choice-sheet';
import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radii, Spacing } from '@/constants/theme';
import { useUserSettings } from '@/features/settings/useUserSettings';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
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

type ChoiceState = {
  title: string;
  subtitle?: string;
  value: string;
  options: ChoiceOption<string>[];
  onSelect: (value: string) => void;
};

function formatMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:00`;
}

function hourOptions(): ChoiceOption<string>[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour * 60),
    label: `${String(hour).padStart(2, '0')}:00`,
  }));
}

/** Notifications : préférences serveur, appareil et sourdine par discussion. */
export default function NotificationsSettingsScreen() {
  const { token, user, setUser } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { settings, error, update } = useUserSettings();
  const [choice, setChoice] = useState<ChoiceState | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [pushStatus, setPushStatus] = useState<'granted' | 'denied' | 'undetermined'>(
    'undetermined',
  );
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const notificationsEnabled = settings.notifications.enabled;

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const [list, status] = await Promise.all([
        api.listConversations(token),
        getPushPermissionStatus(),
      ]);
      setConversations(list);
      setPushStatus(status);
      setDeviceError(null);
      // Permission déjà accordée : on enregistre le jeton sans rien redemander.
      if (status === 'granted' && notificationsEnabled) {
        const pushToken = await requestPushToken();
        if (pushToken) {
          await api.registerPushToken(token, pushToken);
        }
      }
    } catch (cause) {
      setDeviceError(
        cause instanceof ApiError ? cause.message : fr.settings.conversationsLoadError,
      );
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

  const apply = (patch: Parameters<typeof update>[0]) => {
    const payload = { ...patch };
    // Les heures calmes sont exprimées dans le fuseau de l'appareil.
    if (payload.quietHours) {
      payload.quietHours = {
        ...payload.quietHours,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      };
    }
    void update(payload).catch((cause) => {
      Alert.alert(
        fr.settings.saveErrorTitle,
        cause instanceof ApiError ? cause.message : fr.settings.serverError,
      );
    });
  };

  const toggleGlobal = async (value: boolean) => {
    try {
      await update({ notifications: { enabled: value } });
      setUser({ ...user, notificationsEnabled: value });
      if (value) {
        const pushToken = await requestPushToken();
        if (pushToken) {
          await api.registerPushToken(token, pushToken);
        }
        setPushStatus(await getPushPermissionStatus());
      }
    } catch (cause) {
      setDeviceError(cause instanceof ApiError ? cause.message : fr.settings.changeFailed);
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
    } catch (cause) {
      setDeviceError(cause instanceof ApiError ? cause.message : fr.settings.changeFailed);
    }
  };

  const quietChoice = (field: 'startMinute' | 'endMinute', title: string) => {
    setChoice({
      title,
      subtitle: fr.settings.quietHint,
      value: String(settings.quietHours[field]),
      options: hourOptions(),
      onSelect: (value) => apply({ quietHours: { [field]: Number(value) } }),
    });
  };

  const pushStatusLabel =
    pushStatus === 'granted'
      ? fr.settings.pushGranted
      : pushStatus === 'denied'
        ? fr.settings.pushDenied
        : fr.settings.pushUndetermined;

  const pushHint =
    pushStatus === 'granted'
      ? fr.settings.pushHintGranted
      : pushStatus === 'denied'
        ? fr.settings.pushHintDenied
        : fr.settings.pushHintUndetermined;

  const section = (title: string) => (
    <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
      {title}
    </ThemedText>
  );

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: fr.settings.notificationsTitle }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        {error ? (
          <ThemedText type="small" themeColor="textSecondary">
            {error}
          </ThemedText>
        ) : null}

        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Bell}
            label={fr.settings.notificationsGlobal}
            toggle={{
              value: settings.notifications.enabled,
              onChange: (value) => void toggleGlobal(value),
            }}
            style={styles.lastRow}
          />
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          {fr.settings.notificationsGlobalHint}
        </ThemedText>

        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.messages}
            toggle={{
              value: settings.notifications.messages,
              onChange: (value) => apply({ notifications: { messages: value } }),
            }}
          />
          <SettingRow
            icon={CircleUserRound}
            label={fr.settings.groups}
            toggle={{
              value: settings.notifications.groups,
              onChange: (value) => apply({ notifications: { groups: value } }),
            }}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.mentions}
            toggle={{
              value: settings.notifications.mentions,
              onChange: (value) => apply({ notifications: { mentions: value } }),
            }}
          />
          <SettingRow
            icon={Phone}
            label={fr.settings.callsCategory}
            toggle={{
              value: settings.notifications.calls,
              onChange: (value) => apply({ notifications: { calls: value } }),
            }}
          />
          <SettingRow
            icon={MessageSquare}
            label={fr.settings.reactions}
            toggle={{
              value: settings.notifications.reactions,
              onChange: (value) => apply({ notifications: { reactions: value } }),
            }}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.preview}
            toggle={{
              value: settings.notifications.preview,
              onChange: (value) => apply({ notifications: { preview: value } }),
            }}
          />
          <SettingRow
            icon={Bell}
            label={fr.settings.sound}
            toggle={{
              value: settings.notifications.sound,
              onChange: (value) => apply({ notifications: { sound: value } }),
            }}
          />
          <SettingRow
            icon={Moon}
            label={fr.settings.quietHours}
            value={fr.settings.quietHoursValue(
              formatMinute(settings.quietHours.startMinute),
              formatMinute(settings.quietHours.endMinute),
            )}
            toggle={{
              value: settings.quietHours.enabled,
              onChange: (value) => apply({ quietHours: { enabled: value } }),
            }}
            style={styles.lastRow}
          />
        </View>
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            label={fr.settings.quietStart}
            value={formatMinute(settings.quietHours.startMinute)}
            onPress={() => quietChoice('startMinute', fr.settings.quietStart)}
          />
          <SettingRow
            label={fr.settings.quietEnd}
            value={formatMinute(settings.quietHours.endMinute)}
            onPress={() => quietChoice('endMinute', fr.settings.quietEnd)}
            style={styles.lastRow}
          />
        </View>

        {section(fr.settings.notificationsDevice)}
        <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
          <SettingRow
            icon={Smartphone}
            label={fr.settings.pushStatus}
            value={pushStatusLabel}
            style={pushStatus === 'denied' ? undefined : styles.lastRow}
          />
          {pushStatus === 'denied' ? (
            <SettingRow
              icon={ExternalLink}
              label={fr.settings.openAndroidSettings}
              onPress={() => void Linking.openSettings()}
              style={styles.lastRow}
            />
          ) : null}
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          {pushHint}
        </ThemedText>

        {Platform.OS === 'android' ? (
          <>
            {section(fr.settings.notificationsBackground)}
            <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
              <SettingRow
                icon={BatteryCharging}
                label={fr.settings.batteryOptimization}
                onPress={openBatteryOptimizationSettings}
              />
              <SettingRow
                icon={Maximize2}
                label={fr.settings.fullScreenCalls}
                onPress={openFullScreenIntentSettings}
                style={styles.lastRow}
              />
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              {fr.settings.backgroundHint}
            </ThemedText>
          </>
        ) : null}

        {section(fr.settings.notificationsPerChat)}
        {conversations.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary">
            {fr.settings.perChatEmpty}
          </ThemedText>
        ) : (
          <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
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
                    styles.chatRow,
                    { borderBottomColor: theme.backgroundSelected },
                    index === conversations.length - 1 ? styles.lastRow : null,
                    pressed ? { backgroundColor: theme.backgroundSelected } : null,
                  ]}>
                  <Avatar
                    name={title}
                    size={36}
                    uri={isGroup ? conversation.avatarUrl : other?.avatarUrl}
                    gender={other?.gender}
                    variant={isGroup ? 'group' : 'user'}
                    emoji={isGroup ? conversation.emoji : null}
                    color={isGroup ? conversation.color : null}
                  />
                  <ThemedText style={styles.chatLabel} numberOfLines={1}>
                    {title}
                  </ThemedText>
                  <Switch
                    value={!conversation.muted}
                    onValueChange={(value) => void toggleMute(conversation, value)}
                    trackColor={{ true: '#3c87f7', false: theme.backgroundElement }}
                    thumbColor="#ffffff"
                  />
                </Pressable>
              );
            })}
          </View>
        )}

        {deviceError ? (
          <ThemedText type="small" style={styles.error}>
            {deviceError}
          </ThemedText>
        ) : null}
      </ScrollView>

      {choice ? (
        <ChoiceSheet
          visible
          title={choice.title}
          subtitle={choice.subtitle}
          options={choice.options}
          value={choice.value}
          onSelect={(value) => {
            choice.onSelect(value);
            setChoice(null);
          }}
          onClose={() => setChoice(null)}
        />
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  sectionTitle: { letterSpacing: 0.8, marginTop: Spacing.two },
  group: { borderRadius: Radii.md, overflow: 'hidden' },
  lastRow: { borderBottomWidth: 0 },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 56,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chatLabel: { flex: 1, fontSize: 16 },
  error: { color: '#e5484d' },
});
