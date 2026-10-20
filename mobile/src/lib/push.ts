import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type * as ExpoNotifications from 'expo-notifications';

/**
 * Notifications push (Expo Push Service).
 *
 * Le module natif est chargé à la demande : si le build ne l'intègre pas
 * encore, l'app continue de fonctionner (sans push).
 *
 * Documentation : https://docs.expo.dev/versions/v58.0.0/sdk/notifications/
 */

export const PUSH_CHANNEL_ID = 'messages';

type NotificationsModule = typeof ExpoNotifications;

let notificationsModule: NotificationsModule | null | undefined;

function getNotifications(): NotificationsModule | null {
  if (notificationsModule === undefined) {
    // Le runtime natif Expo installe `globalThis.expo` au démarrage. Tant
    // qu'il n'est pas là, exiger expo-notifications lève « Cannot read
    // property 'EventEmitter' of undefined » : on retente plus tard.
    if (!(globalThis as { expo?: unknown }).expo) {
      return null;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      notificationsModule = require('expo-notifications') as NotificationsModule;
    } catch {
      notificationsModule = null;
    }
  }
  return notificationsModule;
}

/** Affiche la notification même quand l'app est au premier plan. */
export function configureNotificationHandler(): void {
  const module = getNotifications();
  if (!module) {
    return;
  }
  module.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

/** État de l'autorisation : granted | denied | undetermined. */
export async function getPushPermissionStatus(): Promise<'granted' | 'denied' | 'undetermined'> {
  const module = getNotifications();
  if (!module) {
    return 'undetermined';
  }
  try {
    const { status } = await module.getPermissionsAsync();
    if (status === 'granted') {
      return 'granted';
    }
    if (status === 'denied') {
      return 'denied';
    }
    return 'undetermined';
  } catch {
    return 'undetermined';
  }
}

/**
 * Demande l'autorisation et renvoie le jeton push Expo (null si refusé
 * ou si le module n'est pas disponible).
 */
export async function requestPushToken(): Promise<string | null> {
  const module = getNotifications();
  if (!module) {
    return null;
  }
  try {
    // Android 13+ : le canal doit exister avant la demande de permission.
    if (Platform.OS === 'android') {
      await module.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
        name: 'Messages',
        importance: module.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 150, 200],
        lightColor: '#3c87f7',
      });
    }

    const existing = await module.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const answer = await module.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
      status = answer.status;
    }
    if (status !== 'granted') {
      return null;
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      return null;
    }
    const { data } = await module.getExpoPushTokenAsync({ projectId });
    return data ?? null;
  } catch {
    return null;
  }
}
