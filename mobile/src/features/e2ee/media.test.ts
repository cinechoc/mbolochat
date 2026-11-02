import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import { saveLocalMessage } from './db';
import { sendEncryptedMedia, PHOTO_MAX_EDGE, THUMB_MAX_EDGE } from './media';
import { encryptEnvelope } from './text';
import type { ConversationSummary } from '@/lib/types';

/** Fichiers présents dans la zone de travail, avec leur taille annoncée. */
const files = new Map<string, number>();
let releases = 0;
let manipulations: { uri: string; maxWidth?: number }[] = [];

vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: { uri?: string }[]) {
      this.uri = parts
        .map((part) => (typeof part === 'string' ? part : (part.uri ?? '')))
        .join('/')
        .replace(/([^:])\/{2,}/g, '$1/');
    }
    get size(): number {
      return files.get(this.uri) ?? 0;
    }
    async move(destination: { uri: string }): Promise<void> {
      const size = this.size;
      files.delete(this.uri);
      files.set(destination.uri, size);
      this.uri = destination.uri;
    }
  }
  return { File, Directory: class {}, Paths: { document: {}, cache: {} } };
});

vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (uri: string, options?: { maxWidth?: number }) => {
      manipulations.push({ uri, maxWidth: options?.maxWidth });
      return {
        renderAsync: async () => ({
          saveAsync: async () => {
            const uri = `rendered-${manipulations.length}.jpg`;
            // Le rendu est bien un fichier sur le disque, comme sur l'appareil.
            files.set(uri, options?.maxWidth === THUMB_MAX_EDGE ? 40 : 400);
            return { uri, width: options?.maxWidth ?? 100, height: 80 };
          },
        }),
      };
    },
  },
}));

vi.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: vi.fn(async () => {
    files.set('rendered-video-thumb.jpg', 30);
    return { uri: 'rendered-video-thumb.jpg', width: 320, height: 180 };
  }),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: { encryptFile: vi.fn() },
}));

vi.mock('@/lib/api', () => ({ api: { uploadMedia: vi.fn() } }));

vi.mock('@/lib/socket', () => ({ ensureSocket: vi.fn() }));

vi.mock('./db', () => ({
  saveLocalMessage: vi.fn(),
  renameLocalMessage: vi.fn(),
}));

vi.mock('./text', () => ({ encryptEnvelope: vi.fn() }));

vi.mock('./mediaStore', () => ({
  fileSystemPath: (uri: string) => uri,
  reserveStage: () => ({ uri: 'file:///cache/stage-1' }),
  releaseStage: () => {
    releases += 1;
    files.clear();
  },
}));

const cryptoMock = vi.mocked(MboloCrypto);
const apiMock = vi.mocked(api);
const socketMock = vi.mocked(ensureSocket);
const dbMock = { saveLocalMessage: vi.mocked(saveLocalMessage) };
const envelopeMock = vi.mocked(encryptEnvelope);

const conversation: ConversationSummary = {
  id: 'conv-1',
  type: 'DIRECT',
  name: null,
  avatarUrl: null,
  emoji: null,
  color: null,
  description: null,
  ownerId: null,
  whoCanSend: 'all',
  whoCanAdd: 'all',
  createdAt: '',
  updatedAt: '',
  e2eeSince: '2026-01-01T00:00:00.000Z',
  members: [
    { id: 'me', username: 'moi', displayName: 'Moi', avatarUrl: null, gender: null, lastReadAt: null, role: 'member' },
    { id: 'peer', username: 'pair', displayName: 'Pair', avatarUrl: null, gender: null, lastReadAt: null, role: 'member' },
  ],
  lastMessage: null,
  unreadCount: 0,
  pinned: false,
  muted: false,
  hidden: false,
  myRole: 'member',
  blockedByMe: false,
  blockedByThem: false,
};

const account = {
  account_pickle: 'pickle',
  device_id: 'dev-1',
  identity_key: 'ident',
  signing_key: 'sign',
} as never;

const imageAsset = {
  uri: 'file:///photos/original.jpg',
  kind: 'image' as const,
  mime: 'image/jpeg',
  name: 'photo.jpg',
  size: 500,
};

let emitted: { event: string; body: Record<string, unknown> }[] = [];
let uploadCount = 0;

function socketStub(result: unknown = { id: 'srv-1', createdAt: '2026-01-02T00:00:00.000Z' }) {
  return {
    timeout: () => ({
      emitWithAck: async (event: string, body: Record<string, unknown>) => {
        emitted.push({ event, body });
        return result;
      },
    }),
  } as never;
}

beforeEach(() => {
  files.clear();
  releases = 0;
  manipulations = [];
  emitted = [];
  uploadCount = 0;
  vi.clearAllMocks();
  // Le clair d'origine, la photo réduite et la vignette existent dans la zone.
  files.set('file:///cache/stage-1/photo.jpg', 400);
  files.set('file:///cache/stage-1/thumb.jpg', 40);
  cryptoMock.encryptFile.mockImplementation(async (_plain: string, output: string) => {
    files.set(output, 999);
    return {
      file_key_b64: 'key',
      nonce_b64: 'nonce',
      sha256_hex: 'ab'.repeat(32),
      plaintext_size: 400,
      ciphertext_size: 999,
    } as never;
  });
  apiMock.uploadMedia.mockImplementation(async () => {
    uploadCount += 1;
    return { id: `up-${uploadCount}`, type: 'IMAGE', url: '', mime: '', size: 0 } as never;
  });
  socketMock.mockResolvedValue(socketStub());
  envelopeMock.mockResolvedValue({
    payload: 'enveloppe',
    payloadType: 'prekey',
    peerId: 'peer',
    signingKey: 'sign',
    identityKey: 'ident',
    deviceId: 'dev-1',
  });
  dbMock.saveLocalMessage.mockResolvedValue(undefined as never);
});

const send = () =>
  sendEncryptedMedia({
    token: 'jeton',
    db: { runAsync: vi.fn().mockResolvedValue(undefined) } as never,
    account,
    conversation,
    currentUserId: 'me',
    currentUserName: 'Moi',
    asset: imageAsset,
    caption: 'ma photo',
  });

describe('envoi d un média chiffré', () => {
  it('réduit la photo et sa vignette avant de chiffrer', async () => {
    await send();
    // La photo passe par une réduction à 1600 px (retrait EXIF/GPS au passage),
    // la vignette à 320 px : deux manipulations distinctes.
    expect(manipulations.map((item) => item.maxWidth)).toEqual([PHOTO_MAX_EDGE, THUMB_MAX_EDGE]);
    expect(manipulations[0].uri).toBe('file:///photos/original.jpg');
  });

  it('chiffre, téléverse puis envoie — dans cet ordre, et les deux blobs en chiffré', async () => {
    const order: string[] = [];
    cryptoMock.encryptFile.mockImplementation(async (_plain: string, output: string) => {
      order.push('crypt');
      files.set(output, 999);
      return {
        file_key_b64: 'key',
        nonce_b64: 'nonce',
        sha256_hex: 'ab'.repeat(32),
        plaintext_size: 400,
        ciphertext_size: 999,
      } as never;
    });
    apiMock.uploadMedia.mockImplementation(async () => {
      order.push('upload');
      return { id: 'up', type: 'IMAGE', url: '', mime: '', size: 0 } as never;
    });
    socketMock.mockImplementation(async () => {
      order.push('send');
      return socketStub();
    });

    await send();

    expect(order.indexOf('crypt')).toBeLessThan(order.indexOf('upload'));
    expect(order.indexOf('upload')).toBeLessThan(order.indexOf('send'));
    expect(apiMock.uploadMedia).toHaveBeenCalledTimes(2);
    for (const call of apiMock.uploadMedia.mock.calls) {
      expect(call[1]).toMatchObject({ encrypted: true, conversationId: 'conv-1' });
    }
    // Le média porte le type du clair, la vignette est toujours une image.
    expect(apiMock.uploadMedia.mock.calls[0][1]).toMatchObject({ kind: 'IMAGE' });
    expect(apiMock.uploadMedia.mock.calls[1][1]).toMatchObject({ kind: 'IMAGE' });
  });

  it('déclare le rattachement du blob dans l envoi et garde le clair hors du message', async () => {
    await send();
    const body = emitted[0].body;
    expect(body.encryption).toBe('v1');
    expect(body.attachmentId).toBe('up-1');
    expect(JSON.stringify(body)).not.toContain('original.jpg');
    // La clé du média voyage dans l'enveloppe, pas dans le corps du message.
    const [envelopeInput] = envelopeMock.mock.calls[0] as unknown as [{ plaintext: string }];
    expect(envelopeInput.plaintext.length).toBeGreaterThan(0);
  });

  it('efface la zone de travail même quand l envoi échoue', async () => {
    socketMock.mockResolvedValue(socketStub({ error: 'conversation bloquée' }));
    await expect(send()).rejects.toThrow('conversation bloquée');
    expect(releases).toBe(1);
    expect(files.size).toBe(0);
  });

  it('efface la zone de travail même quand le téléversement échoue', async () => {
    apiMock.uploadMedia.mockReset();
    apiMock.uploadMedia.mockRejectedValue(new Error('réseau'));
    await expect(send()).rejects.toThrow('réseau');
    expect(releases).toBe(1);
    expect(files.size).toBe(0);
  });

  it('refuse un clair au-dessus du plafond avant tout chiffrement', async () => {
    await expect(
      sendEncryptedMedia({
        token: 'jeton',
        db: {} as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        asset: { ...imageAsset, size: 11 * 1024 * 1024 },
      }),
    ).rejects.toThrow('media_too_large');
    expect(cryptoMock.encryptFile).not.toHaveBeenCalled();
  });
});
