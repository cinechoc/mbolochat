import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

import { useCalls } from '@/features/calls/CallProvider';

/**
 * Deep link des notifications d'appel :
 * mbolochat://call/<callId>?action=accept|decline
 * Le provider affiche l'écran d'appel ; cet écran ne fait que transmettre
 * l'action puis rendre la main à la navigation.
 */
export default function CallDeepLinkScreen() {
  const { id, action } = useLocalSearchParams<{ id?: string; action?: string }>();
  const { handleDeepLink } = useCalls();
  const router = useRouter();

  useEffect(() => {
    handleDeepLink({ callId: id, action });
    const timer = setTimeout(() => {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/chats');
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [action, handleDeepLink, id, router]);

  return <View style={{ flex: 1, backgroundColor: '#0E1015' }} />;
}
