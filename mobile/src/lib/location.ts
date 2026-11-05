import { PermissionStatus, requireOptionalNativeModule } from 'expo-modules-core';

import { api } from './api';

export type CityCaptureStatus =
  | 'updated'
  | 'unchanged'
  | 'denied'
  | 'mocked'
  | 'unavailable'
  | 'failed';

export type LocationAccessStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export type LocationAccess = {
  status: LocationAccessStatus;
  /** Android peut-il encore afficher la demande, ou faut-il passer par ses réglages ? */
  canAskAgain: boolean;
};

type LocationModule = typeof import('expo-location');
type PermissionLike = {
  granted: boolean;
  status: PermissionStatus;
  canAskAgain?: boolean;
};

let cached: LocationModule | null | undefined;

/**
 * Charge le module natif à la demande : un binaire construit avant l'ajout
 * d'expo-location ne doit pas faire planter le bundle au démarrage.
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

function toAccess(permission: PermissionLike): LocationAccess {
  if (permission.granted) {
    return { status: 'granted', canAskAgain: true };
  }
  if (permission.status === PermissionStatus.UNDETERMINED) {
    return { status: 'undetermined', canAskAgain: permission.canAskAgain ?? true };
  }
  return { status: 'denied', canAskAgain: permission.canAskAgain ?? false };
}

function unavailable(): LocationAccess {
  return { status: 'unavailable', canAskAgain: false };
}

/** État de la permission, sans jamais afficher de demande système. */
export async function getLocationAccess(): Promise<LocationAccess> {
  const Location = await getLocation();
  if (!Location) {
    return unavailable();
  }
  try {
    return toAccess(await Location.getForegroundPermissionsAsync());
  } catch {
    return unavailable();
  }
}

/** Demande la permission : réservé à l'activation depuis les paramètres. */
export async function requestLocationAccess(): Promise<LocationAccess> {
  const Location = await getLocation();
  if (!Location) {
    return unavailable();
  }
  try {
    return toAccess(await Location.requestForegroundPermissionsAsync());
  } catch {
    return unavailable();
  }
}

/**
 * Demande la position approximative et la confie au serveur, qui seul décide
 * de la ville. Ne déclenche jamais de demande de permission : une fois
 * l'accès accordé depuis les paramètres, la détection est silencieuse.
 * Les coordonnées ne sont jamais conservées côté application.
 */
export async function captureCity(token: string): Promise<CityCaptureStatus> {
  const Location = await getLocation();
  if (!Location) {
    return 'unavailable';
  }
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) {
      return 'denied';
    }
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    if (position.mocked === true) {
      return 'mocked';
    }
    const result = await api.updateLocation(token, {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      mocked: false,
    });
    return result.updated ? 'updated' : 'unchanged';
  } catch {
    return 'failed';
  }
}
