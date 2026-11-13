import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatTransport } from '../transport/types';

/**
 * État de saisie **propriétaire de la barre d'entrée**, jamais de l'écran :
 * une frappe ne re-rend donc ni la liste ni l'en-tête. Les écritures de
 * brouillon sont différées, les événements de frappe sont émis par l'appelant.
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const setText = useCallback(
    (value: string) => {
      setTextState(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        transport?.saveDraft(value);
      }, saveDelayMs);
    },
    [transport, saveDelayMs],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    transport?.saveDraft(text);
  }, [transport, text]);

  const reset = useCallback(() => {
    setTextState('');
    transport?.saveDraft('');
  }, [transport]);

  return { text, setText, flush, reset };
}
