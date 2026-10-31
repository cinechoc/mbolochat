import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { UserSettings } from '@/lib/types';

type SettingsPatch = Parameters<typeof api.updateUserSettings>[1];

/** Charge les réglages serveur du compte et les met à jour sans squelette. */
export function useUserSettings() {
  const { token, user } = useAuth();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      setSettings(await api.getUserSettings(token));
      setError(null);
    } catch {
      setError('Impossible de charger les réglages.');
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.getUserSettings(token);
        if (!cancelled) {
          setSettings(next);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('Impossible de charger les réglages.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const update = useCallback(
    async (patch: SettingsPatch) => {
      if (!token) {
        return;
      }
      const next = await api.updateUserSettings(token, patch);
      setSettings(next);
    },
    [token],
  );

  const defaults: UserSettings = {
    privacy: {
      profile: 'everyone',
      write: 'everyone',
      groupAdd: 'everyone',
      call: 'everyone',
      discoverability: 'everyone',
    },
    readReceipts: true,
    typingIndicator: true,
    notifications: {
      enabled: user?.notificationsEnabled ?? true,
      messages: true,
      groups: true,
      mentions: true,
      calls: true,
      reactions: true,
      sound: user?.notificationSound ?? true,
      preview: user?.notificationPreview ?? true,
    },
    quietHours: { enabled: false, startMinute: 1320, endMinute: 420, utcOffsetMinutes: 0 },
    city: null,
    country: null,
    cityUpdatedAt: null,
    birthdateSet: false,
    age: null,
  };

  return { settings: settings ?? defaults, loading: settings === null, error, reload, update };
}
