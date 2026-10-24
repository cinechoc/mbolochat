import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  HIDDEN_PRESENCE,
  getPresenceRecord,
  presenceNow,
  subscribePresenceUser,
  type PresenceStatus,
} from './presenceStore';

export interface PresenceValue {
  state: PresenceStatus;
  lastSeenAt?: Date;
}

const NOOP = () => undefined;

/**
 * Suit un utilisateur tant que le composant est monté (et `enabled`). Le store
 * mutualise l'abonnement entre tous les composants qui regardent la même personne.
 */
export function usePresence(
  userId: string | null | undefined,
  enabled = true,
): PresenceValue {
  const id = userId ?? '';
  const active = enabled && id.length > 0;

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active) return NOOP;
      return subscribePresenceUser(id, listener);
    },
    [active, id],
  );

  const getSnapshot = useCallback(
    () => (active ? getPresenceRecord(id) : HIDDEN_PRESENCE),
    [active, id],
  );

  const record = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(
    () => ({
      state: record.state,
      lastSeenAt: record.lastSeenAt ? new Date(record.lastSeenAt) : undefined,
    }),
    [record.lastSeenAt, record.state],
  );
}

export { presenceNow };
