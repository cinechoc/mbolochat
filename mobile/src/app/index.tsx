import { Redirect } from 'expo-router';
import { StyleSheet } from 'react-native';

import { LogoMark } from '@/components/logo';
import { ThemedView } from '@/components/themed-view';
import { useAuth } from '@/lib/auth-context';

export default function IndexScreen() {
  const { token, loading } = useAuth();

  if (loading) {
    // Écran de démarrage : le logo, comme sur WhatsApp. Pas de spinner.
    return (
      <ThemedView style={styles.container}>
        <LogoMark size={84} />
      </ThemedView>
    );
  }

  return <Redirect href={token ? '/chats' : '/login'} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
