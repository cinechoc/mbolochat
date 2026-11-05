import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { decryptIncoming } from './text';
import {
  loadPeerSigningKey,
  loadSession,
  saveLocalMessage,
  savePeerSigningKey,
  saveSession,
  type E2eeAccountRow,
  type E2eeSessionRow,
} from './db';
import type { Message } from '@/lib/types';

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {
    secureDecrypt: vi.fn(),
    secureCreateInbound: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  api: { getE2eeKeyBundle: vi.fn() },
}));

vi.mock('@/lib/socket', () => ({
  ensureSocket: vi.fn(),
}));

vi.mock('./db', () => ({
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  loadPeerSigningKey: vi.fn(),
  savePeerSigningKey: vi.fn(),
  saveLocalMessage: vi.fn(),
}));

const cryptoMock = vi.mocked(MboloCrypto);
const apiMock = vi.mocked(api);
const dbMock = {
  loadSession: vi.mocked(loadSession),
  saveSession: vi.mocked(saveSession),
  loadPeerSigningKey: vi.mocked(loadPeerSigningKey),
  savePeerSigningKey: vi.mocked(savePeerSigningKey),
  saveLocalMessage: vi.mocked(saveLocalMessage),
};

const account: E2eeAccountRow = {
  account_pickle: 'account-pickle',
  device_id: 'dev-1',
  identity_key: 'ident',
  signing_key: 'sign',
};

const oldSession: E2eeSessionRow = {
  peer_user_id: 'peer-1',
  peer_device_id: 'peer-dev-1',
  session_pickle: 'old-session',
  peer_identity_key: 'peer-ident-1',
  peer_signing_key: 'peer-sign-1',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const prekeyMessage: Message = {
  id: 'msg-1',
  conversationId: 'conv-1',
  type: 'text',
  content: '',
  encryption: 'v1',
  payload: 'enveloppe',
  payloadType: 'prekey',
  sender: { id: 'peer-1', displayName: 'Pair' },
  createdAt: '2026-01-02T00:00:00.000Z',
  clientId: null,
} as unknown as Message;

// Reproduce l'encodage de text.ts : encodeURIComponent → octets → base64.
const plaintext = (text: string) => {
  const encoded = encodeURIComponent(JSON.stringify({ v: 1, text }));
  let binary = '';
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      binary += String.fromCharCode(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      binary += encoded[index];
    }
  }
  return btoa(binary);
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.saveSession.mockResolvedValue(undefined as never);
  dbMock.saveLocalMessage.mockResolvedValue(undefined as never);
  dbMock.savePeerSigningKey.mockResolvedValue(undefined as never);
});

describe('decryptIncoming — repli après changement de clé', () => {
  it('récupère un message prekey qui échoue sur la session existante', async () => {
    dbMock.loadSession.mockResolvedValue(oldSession);
    dbMock.loadPeerSigningKey.mockResolvedValue('peer-sign-1');
    cryptoMock.secureDecrypt.mockRejectedValue(new Error('decryption'));
    apiMock.getE2eeKeyBundle.mockResolvedValue({
      deviceId: 'peer-dev-2',
      identityKey: 'peer-ident-2',
      signingKey: 'peer-sign-2',
      signedPrekey: null,
      signedPrekeySignature: null,
      oneTimeKey: null,
      fallback: null,
    });
    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-pickle-2',
      session_pickle: 'new-session',
      session_id: 'sid',
      message_type: 'prekey',
      message: 'unused',
      plaintext_b64: plaintext('salut'),
    });

    const result = await decryptIncoming({
      token: 't',
      db: {} as never,
      account,
      message: prekeyMessage,
      currentUserId: 'me',
    });

    expect(result.text).toBe('salut');
    expect(result.keyChanged).toBe(true);
    expect(result.account.account_pickle).toBe('account-pickle-2');
    expect(cryptoMock.secureCreateInbound).toHaveBeenCalledWith(
      'account-pickle',
      'peer-ident-2',
      'enveloppe',
    );
    expect(dbMock.savePeerSigningKey).toHaveBeenCalledWith(
      expect.anything(),
      'peer-1',
      'peer-sign-2',
      true,
    );
  });

  it('écrit le message avant de faire avancer la session', async () => {
    const order: string[] = [];
    dbMock.saveLocalMessage.mockImplementation((async () => {
      order.push('message');
    }) as never);
    dbMock.saveSession.mockImplementation((async () => {
      order.push('session');
    }) as never);
    dbMock.loadSession.mockResolvedValue(oldSession);
    dbMock.loadPeerSigningKey.mockResolvedValue('peer-sign-1');
    cryptoMock.secureDecrypt.mockResolvedValue({
      session_pickle: 'advanced-session',
      plaintext_b64: plaintext('ok'),
    });

    await decryptIncoming({
      token: 't',
      db: {} as never,
      account,
      message: { ...prekeyMessage, payloadType: 'normal' },
      currentUserId: 'me',
    });

    expect(order).toEqual(['message', 'session']);
  });

  it('repropage l’échec d’un message normal non déchiffrable (pas de faux repli)', async () => {
    dbMock.loadSession.mockResolvedValue(oldSession);
    dbMock.loadPeerSigningKey.mockResolvedValue('peer-sign-1');
    cryptoMock.secureDecrypt.mockRejectedValue(new Error('decryption'));

    await expect(
      decryptIncoming({
        token: 't',
        db: {} as never,
        account,
        message: { ...prekeyMessage, payloadType: 'normal' },
        currentUserId: 'me',
      }),
    ).rejects.toThrow('decryption');
    expect(cryptoMock.secureCreateInbound).not.toHaveBeenCalled();
  });
});
