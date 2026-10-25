import { useEffect, useSyncExternalStore } from 'react';

import {
  getStickerLibrary,
  loadStickerLibrary,
  subscribeStickerLibrary,
  type StickerLibraryState,
} from './stickerLibrary';

/** État local synchronisé des stickers personnels, favoris et récents. */
export function useStickerLibrary(): StickerLibraryState {
  const state = useSyncExternalStore(
    subscribeStickerLibrary,
    getStickerLibrary,
    getStickerLibrary,
  );
  useEffect(() => {
    void loadStickerLibrary().catch(() => undefined);
  }, []);
  return state;
}
