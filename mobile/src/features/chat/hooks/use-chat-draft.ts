import { useCallback, useEffect, useRef, useState } from 'react';

import { createDraftBuffer, type DraftBuffer } from '../model/draft-buffer';
import type { ChatTransport } from '../transport/types';

/**
 * État de saisie **propriétaire de la barre d'entrée**, jamais de l'écran.
 * La temporisation vit dans `draft-buffer.ts` (testable sans React).
 */
export function useChatDraft(input: {
  transport: ChatTransport | null;
  initialText?: string;
  saveDelayMs?: number;
}): {
  text: string;
  setText: (value: string) => void;
  flush: () => void;
  reset: () => void;
} {
  const { transport, initialText = '', saveDelayMs = 300 } = input;
  const [text, setTextState] = useState(initialText);
  const bufferRef = useRef<DraftBuffer | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    const buffer = createDraftBuffer({
      save: (value) => transport?.saveDraft(value),
      delayMs: saveDelayMs,
    });
    bufferRef.current = buffer;
    return () => {
      buffer.dispose();
      bufferRef.current = null;
    };
  }, [transport, saveDelayMs]);

  // Brouillon stocké (chiffré ou cache) : chargé après le premier rendu, il ne
  // remplace jamais une saisie déjà commencée.
  useEffect(() => {
    if (!transport) return;
    let active = true;
    void transport.loadDraft().then((stored) => {
      if (active && !dirtyRef.current && stored) {
        setTextState(stored);
      }
    });
    return () => {
      active = false;
    };
  }, [transport]);

  const setText = useCallback((value: string) => {
    dirtyRef.current = true;
    setTextState(value);
    bufferRef.current?.set(value);
  }, []);

  const flush = useCallback(() => {
    bufferRef.current?.flush();
  }, []);

  const reset = useCallback(() => {
    dirtyRef.current = false;
    setTextState('');
    bufferRef.current?.set('');
    bufferRef.current?.flush();
  }, []);

  return { text, setText, flush, reset };
}
