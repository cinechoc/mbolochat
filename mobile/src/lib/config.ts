import Constants from 'expo-constants';
import { Platform } from 'react-native';

function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) {
    return fromEnv;
  }
  if (Platform.OS === 'web') {
    // Served by the API (production): same origin. Served by Expo dev server: point at the API.
    const location = (globalThis as { location?: { hostname?: string; port?: string } }).location;
    const isExpoDevServer =
      process.env.NODE_ENV === 'development' &&
      (location?.port === '8081' || location?.port === '8080');
    if (isExpoDevServer && location?.hostname) {
      return `http://${location.hostname}:3001`;
    }
    return '';
  }
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0];
  if (host) {
    return `http://${host}:3001`;
  }
  return 'http://localhost:3001';
}

export const API_URL = resolveApiUrl();
