export interface DraftScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface DraftBufferInput {
  save: (text: string) => void;
  delayMs?: number;
  scheduler?: DraftScheduler;
}

export interface DraftBuffer {
  set(text: string): void;
  flush(): void;
  pending(): string | null;
  dispose(): void;
  /** Écrit la dernière valeur puis libère le minuteur (démontage de l’écran). */
  close(): void;
}

const defaultScheduler: DraftScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Écritures de brouillon différées et sérialisées par le temps.
 *
 * La logique est isolée du hook React : un seul minuteur en vol, la dernière
 * valeur gagne, et `flush` garantit l'écriture avant fermeture de l'écran.
 */
export function createDraftBuffer({
  save,
  delayMs = 300,
  scheduler = defaultScheduler,
}: DraftBufferInput): DraftBuffer {
  let pending: string | null = null;
  let handle: unknown = null;

  const cancel = () => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
  };

  const flush = () => {
    cancel();
    if (pending !== null) {
      const value = pending;
      pending = null;
      save(value);
    }
  };

  return {
    set(text: string) {
      pending = text;
      cancel();
      handle = scheduler.schedule(flush, delayMs);
    },
    flush,
    pending: () => pending,
    dispose() {
      cancel();
      pending = null;
    },
    close() {
      flush();
      cancel();
    },
  };
}
