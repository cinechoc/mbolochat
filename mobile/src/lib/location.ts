import { requireOptionalNativeModule } from 'expo-modules-core';

import { api } from './api';

export type CityCaptureStatus =
  | 'updated'
  | 'unchanged'
  | 'denied'
  | 'mocked'
  | 'unavailable';

type LocationModule = typeof import('expo-location');

let cached: LocationModule | null | undefined;

/**
 * Charge le module natif à la demande : l'APK actuel ne contient pas encore
 * expo-location, et un import statique ferait planter le bundle au démarrage.
 * Après le prochain rebuild EAS, la ville devient disponible sans changement.
 */
function nativeLocationPresent(): boolean {
  try {
    return requireOptionalNativeModule('ExpoLocation') !== null;
  } catch {
    return false;
  }
}

async function getLocation(): Promise<LocationModule | null> {
  if (cached !== undefined) {
    return cached;
  }
  if (!nativeLocationPresent()) {
    cached = null;
    return null;
  }
  try {
    cached = await import('expo-location');
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Demande la position approximative et la confie au serveur, qui seul décide
 * de la ville. Les coordonnées ne sont jamais conservées côté application.
 */
export async function captureCity(token: string): Promise<CityCaptureStatus> {
  const Location = await getLocation();
  if (!Location) {
    return 'unavailable';
  }
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      return 'denied';
    }
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    if ((position as { mocked?: boolean }).mocked === true) {
      return 'mocked';
    }
    const result = await api.updateLocation(token, {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      mocked: false,
    });
    return result.updated ? 'updated' : 'unchanged';
  } catch {
    return 'unavailable';
  }
}

/** Disponibilité réelle du module natif dans ce binaire. */
export async function locationAvailable(): Promise<boolean> {
  const Location = await getLocation();
  if (!Location) {
    return false;
  }
  try {
    await Location.getForegroundPermissionsAsync();
    return true;
  } catch {
    return false;
  }
}
