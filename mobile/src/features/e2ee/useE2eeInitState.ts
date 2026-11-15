import { useSyncExternalStore } from 'react';

import {
  getE2eeInitState,
  subscribeE2eeInit,
  type E2eeInitState,
} from './initState';

/** État d'initialisation E2EE, réactif et partagé avec la porte de démarrage. */
export function useE2eeInitState(): E2eeInitState {
  return useSyncExternalStore(subscribeE2eeInit, getE2eeInitState, getE2eeInitState);
}
