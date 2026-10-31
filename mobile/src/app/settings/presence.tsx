import { Redirect, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing, Radii } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type {
  LastSeenVisibility,
  OnlineVisibility,
  PresenceSettings,
} from '@/lib/types';

const LAST_SEEN_OPTIONS: { value: LastSeenVisibility; label: string }[] = [
  { value: 'everyone', label: 'Tout le monde' },
  { value: 'contacts', label: 'Mes contacts' },
  { value: 'nobody', label: 'Personne' },
];

const ONLINE_OPTIONS: { value: OnlineVisibility; label: string }[] = [
  { value: 'everyone', label: 'Tout le monde' },
  { value: 'same_as_last_seen', label: 'Comme la dernière connexion' },
];

function RadioRow({
  label,
  checked,
  color,
  last = false,
  onPress,
}: {
  label: string;
  checked: boolean;
  color: string;
  last?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: theme.backgroundElement,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        },
        pressed ? { backgroundColor: theme.backgroundSelected } : null,
      ]}>
      <ThemedText style={styles.rowLabel}>{label}</ThemedText>
      <View style={[styles.radio, { borderColor: checked ? color : theme.textSecondary }]}>
        {checked ? <View style={[styles.radioDot, { backgroundColor: color }]} /> : null}
      </View>
    </Pressable>
  );
}

export default function PresenceSettingsScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const chat = useChatColors();
  const insets = useSafeAreaInsets();

  const [settings, setSettings] = useState<PresenceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const fetchSettings = useCallback(async () => {
    if (!token) return;
    try {
      const next = await api.getPresenceSettings(token);
      setSettings(next);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Impossible de charger ces réglages.',
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    (async () => {
      try {
        const next = await api.getPresenceSettings(token);
        if (active) {
          setSettings(next);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof ApiError ? err.message : 'Impossible de charger ces réglages.',
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    void fetchSettings();
  }, [fetchSettings]);

  const choose = useCallback(
    (patch: Partial<PresenceSettings>) => {
      if (!settings || !token) return;
      const previous = settings;
      const next = { ...settings, ...patch };
      setSettings(next);
      setError(null);
      const id = ++requestId.current;
      void (async () => {
        try {
          const saved = await api.updatePresenceSettings(token, patch);
          if (id === requestId.current) {
            setSettings(saved);
          }
        } catch (err) {
          if (id !== requestId.current) return;
          setSettings(previous);
          Alert.alert(
            'Enregistrement impossible',
            err instanceof ApiError ? err.message : 'Réessaie dans un instant.',
          );
        }
      })();
    },
    [settings, token],
  );

  if (!token) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Dernière connexion et en ligne' }} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={chat.send} />
        </View>
      ) : !settings ? (
        <View style={styles.center}>
          <ThemedText themeColor="textSecondary" style={styles.errorText}>
            {error ?? 'Impossible de charger ces réglages.'}
          </ThemedText>
          <Pressable
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Réessayer de charger les réglages"
            style={[styles.retry, { borderColor: theme.backgroundElement }]}>
            <ThemedText style={styles.retryText}>Réessayer</ThemedText>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + Spacing.four },
          ]}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            QUI PEUT VOIR MA DERNIÈRE CONNEXION
          </ThemedText>
          <ThemedView style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
            {LAST_SEEN_OPTIONS.map((option, index) => (
              <RadioRow
                key={option.value}
                label={option.label}
                checked={settings.lastSeenVisibility === option.value}
                color={chat.send}
                last={index === LAST_SEEN_OPTIONS.length - 1}
                onPress={() => {
                  if (settings.lastSeenVisibility !== option.value) {
                    choose({ lastSeenVisibility: option.value });
                  }
                }}
              />
            ))}
          </ThemedView>

          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            QUI PEUT VOIR QUAND JE SUIS EN LIGNE
          </ThemedText>
          <ThemedView style={[styles.group, { backgroundColor: theme.backgroundElement }]}>
            {ONLINE_OPTIONS.map((option, index) => (
              <RadioRow
                key={option.value}
                label={option.label}
                checked={settings.onlineVisibility === option.value}
                color={chat.send}
                last={index === ONLINE_OPTIONS.length - 1}
                onPress={() => {
                  if (settings.onlineVisibility !== option.value) {
                    choose({ onlineVisibility: option.value });
                  }
                }}
              />
            ))}
          </ThemedView>

          <ThemedText type="small" themeColor="textSecondary" style={styles.explanation}>
            Si vous masquez votre dernière connexion, vous ne verrez pas non plus celle des
            autres.
          </ThemedText>
          {error ? (
            <ThemedText type="small" style={styles.errorText}>
              {error}
            </ThemedText>
          ) : null}
        </ScrollView>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  content: {
    paddingTop: Spacing.two,
  },
  sectionTitle: {
    letterSpacing: 0.8,
    marginTop: Spacing.four,
    marginBottom: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  group: {
    borderRadius: Radii.md,
    overflow: 'hidden',
    marginHorizontal: Spacing.three,
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: Radii.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: Radii.full,
  },
  explanation: {
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    lineHeight: 19,
  },
  errorText: {
    color: '#e5484d',
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: Spacing.three,
  },
  retry: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  retryText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
