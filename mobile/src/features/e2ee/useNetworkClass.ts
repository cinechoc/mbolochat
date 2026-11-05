import * as Network from 'expo-network';

import { classifyNetwork, type NetworkClass } from './mediaPolicy';

/**
 * Nature du réseau courant, pour décider du chargement automatique des médias.
 *
 * La décision vit dans `mediaPolicy.ts` (pure, testable sans appareil) ; ici on
 * ne fait que lire l'état de la plateforme. `useNetworkState` s'abonne aux
 * changements et se désabonne au démontage.
 */
export function useNetworkClass(): NetworkClass {
  const state = Network.useNetworkState();
  return classifyNetwork({ type: state.type ?? null, isConnected: state.isConnected ?? null });
}
