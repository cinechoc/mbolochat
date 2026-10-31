import { Redirect, Stack } from 'expo-router';

import { E2eeSpikeScreen } from '@/features/e2ee-dev/E2eeSpikeScreen';
import { isE2eeDevToolsEnabled } from '@/features/e2ee-dev/policy';
import { fr } from '@/i18n/fr';

/** Route de développement : redirige toujours hors développement. */
export default function E2eeSpikeRoute() {
  if (!isE2eeDevToolsEnabled()) {
    return <Redirect href="/" />;
  }
  return (
    <>
      <Stack.Screen options={{ title: fr.e2eeDev.title }} />
      <E2eeSpikeScreen />
    </>
  );
}
