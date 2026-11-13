import { useEffect, useMemo } from 'react';

import { ClassicTransport } from '../transport/classic-transport';
import type { ClassicTransportDeps, ClassicTransportOptions } from '../transport/deps';
import type { ChatTransport } from '../transport/types';

/**
 * Instancie le transport adapté au mode résolu. Non branché sur les écrans
 * avant B.3.5 (drapeau désactivé par défaut).
 *
 * `options` et `deps` doivent être stables (mémoïsés par l'appelant) : un
 * changement d'identité recrée le transport et rejoue le chargement initial.
 */
export function useChatTransport(input: {
  mode: 'classic' | 'e2ee' | 'blocked' | 'pending';
  deps: ClassicTransportDeps;
  options: ClassicTransportOptions | null;
}): ChatTransport | null {
  const { mode, deps, options } = input;
  const transport = useMemo<ChatTransport | null>(() => {
    if (mode !== 'classic' || !options) {
      return null;
    }
    return new ClassicTransport(deps, options);
  }, [mode, deps, options]);

  useEffect(
    () => () => {
      void transport?.dispose();
    },
    [transport],
  );

  return transport;
}
