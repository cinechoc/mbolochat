import Constants from 'expo-constants';
import { Platform } from 'react-native';

function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) {
    return fromEnv;
  }
  if (Platform.OS === 'web') {
    return '';
  }
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0];
  if (host) {
    return `http://${host}:3000`;
  }
  return 'http://localhost:3000';
}

export const API_URL = resolveApiUrl();
