import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const ACCESS_KEY = 'mbolochat_access_token';
const REFRESH_KEY = 'mbolochat_refresh_token';

/**
 * Copie en mémoire du jeton d'accès : le stockage sécurisé est asynchrone,
 * alors que le socket a besoin du jeton courant de façon synchrone.
 */
let cachedAccessToken: string | null = null;

export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function webStorage(): WebStorage | undefined {
  return (globalThis as { localStorage?: WebStorage }).localStorage;
}

export async function getStoredAccessToken(): Promise<string | null> {
  const stored =
    Platform.OS === 'web'
      ? (webStorage()?.getItem(ACCESS_KEY) ?? null)
      : await SecureStore.getItemAsync(ACCESS_KEY);
  cachedAccessToken = stored;
  return stored;
}

export async function getStoredRefreshToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return webStorage()?.getItem(REFRESH_KEY) ?? null;
  }
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function storeTokens(accessToken: string, refreshToken: string): Promise<void> {
  cachedAccessToken = accessToken;
  if (Platform.OS === 'web') {
    webStorage()?.setItem(ACCESS_KEY, accessToken);
    webStorage()?.setItem(REFRESH_KEY, refreshToken);
    return;
  }
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}

export async function storeAccessToken(accessToken: string): Promise<void> {
  cachedAccessToken = accessToken;
  if (Platform.OS === 'web') {
    webStorage()?.setItem(ACCESS_KEY, accessToken);
    return;
  }
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
}

export async function clearStoredTokens(): Promise<void> {
  cachedAccessToken = null;
  if (Platform.OS === 'web') {
    webStorage()?.removeItem(ACCESS_KEY);
    webStorage()?.removeItem(REFRESH_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}
