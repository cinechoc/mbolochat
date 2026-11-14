import * as e2eeDb from '@/features/e2ee/db';
import * as e2eeDeletion from '@/features/e2ee/deletion';
import * as e2eeDeletionFiles from '@/features/e2ee/deletionFiles';
import * as e2eeMedia from '@/features/e2ee/media';
import * as e2eeReceipts from '@/features/e2ee/receipts';
import * as e2eeText from '@/features/e2ee/text';
import { api } from '@/lib/api';
import { cache } from '@/lib/cache';
import * as outbox from '@/lib/outbox';
import * as socket from '@/lib/socket';
import * as sync from '@/lib/sync';
import type { ClassicTransportDeps, E2eeTransportDeps } from './deps';

/** Dépendances de production, injectées dans les transports. */
export const CLASSIC_DEPS: ClassicTransportDeps = {
  api,
  cache,
  outbox,
  socket,
  sync,
  clock: () => Date.now(),
};

export const E2EE_DEPS: E2eeTransportDeps = {
  api,
  cache,
  socket,
  db: e2eeDb,
  crypto: {
    sendEncryptedText: e2eeText.sendEncryptedText,
    sendEncryptedReaction: e2eeText.sendEncryptedReaction,
    sendEncryptedSticker: e2eeText.sendEncryptedSticker,
    sendEncryptedDelete: e2eeText.sendEncryptedDelete,
    sendEncryptedMedia: e2eeMedia.sendEncryptedMedia,
    decryptIncoming: e2eeText.decryptIncoming,
  },
  deletion: { ...e2eeDeletion, ...e2eeDeletionFiles },
  receipts: e2eeReceipts,
  clock: () => Date.now(),
};
