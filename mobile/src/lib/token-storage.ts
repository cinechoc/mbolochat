import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKEN_KEY = 'mbolochat_token';

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function webStorage(): WebStorage | undefined {
  return (globalThis as { localStorage?: WebStorage }).localStorage;
}

export async function getStoredToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return webStorage()?.getItem(TOKEN_KEY) ?? null;
  }
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function storeToken(token: string): Promise<void> {
  if (Platform.OS === 'web') {
    webStorage()?.setItem(TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearStoredToken(): Promise<void> {
  if (Platform.OS === 'web') {
    webStorage()?.removeItem(TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
