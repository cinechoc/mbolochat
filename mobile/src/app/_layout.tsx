import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { configureNotificationHandler, subscribeToNotificationOpens } from '@/lib/push';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Configuré après le montage : charger expo-notifications pendant
  // l'évaluation du bundle casse le démarrage (globalThis.expo pas encore
  // installé par le runtime natif → « runtime not ready »).
  useEffect(() => {
    configureNotificationHandler();
  }, []);

  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <StatusBar style="auto" />
        <RootNavigator />
        <NotificationRouter />
      </ThemeProvider>
    </AuthProvider>
  );
}

/**
 * Toucher une notification ouvre la conversation concernée. La navigation
 * attend la fin de la restauration de session (démarrage à froid).
 */
function NotificationRouter() {
  const { token, loading } = useAuth();
  const pendingRef = useRef<string | null>(null);

  useEffect(
    () =>
      subscribeToNotificationOpens((data) => {
        if (!data.conversationId) {
          return;
        }
        if (loading) {
          pendingRef.current = data.conversationId;
          return;
        }
        if (!token) {
          return;
        }
        router.push({ pathname: '/chat/[id]', params: { id: data.conversationId } });
      }),
    [loading, token],
  );

  // La notification a été touchée pendant le chargement : on ouvre la
  // conversation dès que la session est prête.
  useEffect(() => {
    if (loading || !token) {
      return;
    }
    const pending = pendingRef.current;
    if (!pending) {
      return;
    }
    pendingRef.current = null;
    router.push({ pathname: '/chat/[id]', params: { id: pending } });
  }, [loading, token]);

  return null;
}

function RootNavigator() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.background },
        headerTintColor: theme.text,
        headerTitleStyle: { color: theme.text },
        contentStyle: { backgroundColor: theme.background },
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="register" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ title: 'Mot de passe oublié' }} />
      <Stack.Screen name="chats" options={{ headerShown: false }} />
      <Stack.Screen name="new-chat" options={{ title: 'Nouvelle discussion' }} />
      <Stack.Screen name="chat/[id]" options={{ title: '' }} />
      <Stack.Screen name="profile" options={{ title: 'Profil' }} />
      <Stack.Screen name="profile/edit" options={{ title: 'Modifier le profil' }} />
      <Stack.Screen name="user/[id]" options={{ title: 'Profil' }} />
      <Stack.Screen name="settings" options={{ title: 'Paramètres' }} />
    </Stack>
  );
}
