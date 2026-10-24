import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { PresenceProvider } from '@/features/presence/PresenceProvider';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { drain } from '@/lib/outbox';
import { configureNotificationHandler, subscribeToNotificationOpens } from '@/lib/push';
import { runSync, startReliability } from '@/lib/sync';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Configuré après le montage : charger expo-notifications pendant
  // l'évaluation du bundle casse le démarrage (globalThis.expo pas encore
  // installé par le runtime natif → « runtime not ready »).
  useEffect(() => {
    configureNotificationHandler();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <StatusBar style="auto" />
          <RootNavigator />
          <NotificationRouter />
          <ReliabilityLoop />
          <PresenceProvider />
        </ThemeProvider>
      </AuthProvider>
    </GestureHandlerRootView>
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

/**
 * Rien d'affiché ici : c'est la boucle de fiabilité. Au retour du réseau, elle
 * récupère ce qui est arrivé pendant l'absence et relance les messages qui
 * attendaient d'être envoyés. Le retour d'application fait la même chose, sans
 * attendre une nouvelle connexion.
 */
function ReliabilityLoop() {
  const { token, user, loading } = useAuth();

  useEffect(() => {
    if (loading || !token || !user) {
      return;
    }
    return startReliability(token, user.id);
  }, [loading, token, user]);

  useEffect(() => {
    if (loading || !token || !user) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void runSync(token, user.id);
        void drain(token);
      }
    });
    return () => subscription.remove();
  }, [loading, token, user]);

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
      <Stack.Screen name="document-viewer" options={{ headerShown: false }} />
      <Stack.Screen name="profile" options={{ title: 'Profil' }} />
      <Stack.Screen name="profile/edit" options={{ title: 'Modifier le profil' }} />
      <Stack.Screen name="user/[id]" options={{ title: 'Profil' }} />
      <Stack.Screen name="settings" options={{ title: 'Paramètres' }} />
    </Stack>
  );
}
