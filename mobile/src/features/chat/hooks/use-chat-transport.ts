import { useEffect, useMemo } from 'react';

import { ClassicTransport } from '../transport/classic-transport';
import type {
  ClassicTransportDeps,
  ClassicTransportOptions,
  E2eeTransportDeps,
  E2eeTransportOptions,
} from '../transport/deps';
import { E2eeTransport } from '../transport/e2ee-transport';
import type { ChatTransport } from '../transport/types';

/**
 * Instancie le transport adapté au mode résolu. Non branché sur les écrans
 * avant B.3.5 (drapeau désactivé par défaut).
 *
 * Les objets `classic`/`e2ee` (dépendances et options) doivent être stables
 * (mémoïsés par l'appelant) : un changement d'identité recrée le transport et
 * rejoue le chargement initial.
 */
export function useChatTransport(input: {
  mode: 'classic' | 'e2ee' | 'blocked' | 'pending';
  classic?: {
    deps: ClassicTransportDeps;
    options: ClassicTransportOptions | null;
  };
  e2ee?: {
    deps: E2eeTransportDeps;
    options: E2eeTransportOptions | null;
  };
}): ChatTransport | null {
  const { mode, classic, e2ee } = input;
  const transport = useMemo<ChatTransport | null>(() => {
    if (mode === 'classic' && classic?.options) {
      return new ClassicTransport(classic.deps, classic.options);
    }
    if (mode === 'e2ee' && e2ee?.options) {
      return new E2eeTransport(e2ee.deps, e2ee.options);
    }
    return null;
  }, [mode, classic, e2ee]);

  useEffect(
    () => () => {
      void transport?.dispose();
    },
    [transport],
  );

  return transport;
}
