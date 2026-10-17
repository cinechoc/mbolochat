import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const ACCESS_KEY = 'mbolochat_access_token';
const REFRESH_KEY = 'mbolochat_refresh_token';

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function webStorage(): WebStorage | undefined {
  return (globalThis as { localStorage?: WebStorage }).localStorage;
}

export async function getStoredAccessToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return webStorage()?.getItem(ACCESS_KEY) ?? null;
  }
  return SecureStore.getItemAsync(ACCESS_KEY);
}

export async function getStoredRefreshToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return webStorage()?.getItem(REFRESH_KEY) ?? null;
  }
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function storeTokens(accessToken: string, refreshToken: string): Promise<void> {
  if (Platform.OS === 'web') {
    webStorage()?.setItem(ACCESS_KEY, accessToken);
    webStorage()?.setItem(REFRESH_KEY, refreshToken);
    return;
  }
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}

export async function storeAccessToken(accessToken: string): Promise<void> {
  if (Platform.OS === 'web') {
    webStorage()?.setItem(ACCESS_KEY, accessToken);
    return;
  }
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
}

export async function clearStoredTokens(): Promise<void> {
  if (Platform.OS === 'web') {
    webStorage()?.removeItem(ACCESS_KEY);
    webStorage()?.removeItem(REFRESH_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}
