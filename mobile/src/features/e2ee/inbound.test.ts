import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import type { Message } from '@/lib/types';
import { persistIncoming } from './atomic';
import { loadReactionSummaries, type E2eeAccountRow } from './db';
import * as socketModule from '@/lib/socket';
import { migrateE2eeSchema } from './schema';
import { decryptEnvelope, decryptIncoming } from './text';
import { withAccountLock, withOlmLock } from './locks';

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {
    secureEncrypt: vi.fn(),
    secureCreateOutbound: vi.fn(),
    secureCreateInbound: vi.fn(),
    secureDecrypt: vi.fn(),
    verifyPrekey: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: { getE2eeKeyBundle: vi.fn() } }));
vi.mock('@/lib/socket', () => ({ ensureSocket: vi.fn() }));

const cryptoMock = vi.mocked(MboloCrypto);
const apiMock = vi.mocked(api);

/**
 * Vraie base SQLite en mémoire : l'objet de cette étape est précisément une
 * propriété transactionnelle (rollback, commit conjoint), qu'un mock de
 * `runAsync` ne peut pas démontrer. `withExclusiveTransactionAsync` est émulé
 * à l'identique avec `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
 */
interface Handle {
  execAsync(sql: string): Promise<void>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: Handle) => Promise<void>): Promise<void>;
}

interface Fixture {
  raw: DatabaseSync;
  handle: Handle;
  db: never;
}

function openDb(): Fixture {
  const raw = new DatabaseSync(':memory:');
  // Une seule connexion : les transactions exclusives doivent se succéder,
  // comme le fait expo-sqlite qui les met en file sur la même base.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = (mode: 'BEGIN' | 'BEGIN IMMEDIATE') => (task: (txn: Handle) => Promise<void>) => {
    const run = async () => {
      raw.exec(mode);
      try {
        await task(handle);
        raw.exec('COMMIT');
      } catch (cause) {
        raw.exec('ROLLBACK');
        throw cause;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const handle: Handle = {
    execAsync: async (sql: string) => {
      raw.exec(sql);
    },
    getAllAsync: async <T,>(sql: string, ...params: unknown[]) =>
      raw.prepare(sql).all(...(params as never[])).map((row) => ({ ...row }) as T),
    getFirstAsync: async <T,>(sql: string, ...params: unknown[]) => {
      const row = raw.prepare(sql).get(...(params as never[]));
      return row === undefined ? null : ({ ...row } as T);
    },
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = raw.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    withTransactionAsync: async (task: () => Promise<void>) => {
      await exclusive('BEGIN')(async () => task());
    },
    withExclusiveTransactionAsync: (task: (txn: Handle) => Promise<void>) =>
      exclusive('BEGIN IMMEDIATE')(task),
  };
  return { raw, handle, db: handle as never };
}

const account: E2eeAccountRow = {
  account_pickle: 'account-pickle',
  device_id: 'local-device',
  identity_key: 'local-identity',
  signing_key: 'local-signing',
};

/** Message entrant minimal, tel que le serveur le pousse sur `message:new`. */
function incoming(patch: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'conv-1',
    type: 'text',
    content: '',
    encryption: 'v1',
    payload: 'ENV',
    payloadType: 'normal',
    senderDeviceId: 'dev-1',
    stickerRef: null,
    attachment: null,
    encryptedAttachment: null,
    clientId: null,
    deleted: false,
    replyTo: null,
    reactions: [],
    createdAt: '2026-01-01T00:00:00Z',
    sender: { id: 'peer-1', displayName: 'Pair' },
    ...patch,
  } as unknown as Message;
}

/** Charge utile texte v1, telle qu'elle sort du déchiffrement. */
const plaintext = (text: string) =>
  Buffer.from(JSON.stringify({ v: 1, text }), 'utf8').toString('base64');

const decrypted = (pickle: string, text = 'bonjour') => ({
  session_pickle: pickle,
  session_id: 'sid',
  message_type: 'normal',
  plaintext_b64: plaintext(text),
});

/** Charge utile sticker v3, telle qu'elle sort du déchiffrement. */
const stickerPlain = (stickerRef: string, replyTo?: string) =>
  Buffer.from(
    JSON.stringify({ v: 3, kind: 'sticker', stickerRef, ...(replyTo ? { replyTo } : {}) }),
    'utf8',
  ).toString('base64');

const decryptedSticker = (pickle: string, stickerRef: string, replyTo?: string) => ({
  ...decrypted(pickle),
  plaintext_b64: stickerPlain(stickerRef, replyTo),
});

const reactionPlain = (
  targetId: string,
  reaction = 'mbolo-panther-2d/amour',
  action: 'add' | 'remove' = 'add',
) =>
  Buffer.from(
    JSON.stringify({ v: 4, kind: 'reaction', targetId, reaction, action }),
    'utf8',
  ).toString('base64');

const decryptedReaction = (
  pickle: string,
  targetId: string,
  reaction = 'mbolo-panther-2d/amour',
  action: 'add' | 'remove' = 'add',
) => ({ ...decrypted(pickle), plaintext_b64: reactionPlain(targetId, reaction, action) });

const deletePlain = (targetId: string) =>
  Buffer.from(JSON.stringify({ v: 5, kind: 'delete', targetId }), 'utf8').toString('base64');

const decryptedDelete = (pickle: string, targetId: string) => ({
  ...decrypted(pickle),
  plaintext_b64: deletePlain(targetId),
});

function read(fixture: Fixture, sql: string, ...params: unknown[]) {
  return fixture.raw
    .prepare(sql)
    .all(...(params as never[]))
    .map((row) => ({ ...row }));
}

async function seeded(
  sessions: { peer: string; device: string; pickle: string }[] = [
    { peer: 'peer-1', device: 'dev-1', pickle: 'S0' },
  ],
): Promise<Fixture> {
  const fixture = openDb();
  await migrateE2eeSchema(fixture.db);
  for (const item of sessions) {
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_sessions
         (peer_user_id, peer_device_id, session_pickle, peer_identity_key, peer_signing_key, updated_at)
       VALUES (?, ?, ?, 'peer-ident', 'peer-sign', '2026-01-01T00:00:00Z')`,
      item.peer,
      item.device,
      item.pickle,
    );
  }
  return fixture;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Laisse les microtâches en attente se dérouler. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const decrypt = (fixture: Fixture, message: Message) =>
  decryptIncoming({
    token: 't',
    db: fixture.db,
    account,
    message,
    currentUserId: 'me',
  });

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getE2eeKeyBundle.mockResolvedValue({
    deviceId: 'dev-1',
    identityKey: 'peer-ident',
    signingKey: 'peer-sign',
    signedPrekey: null,
    signedPrekeySignature: null,
    oneTimeKey: null,
    fallback: null,
  });
});

describe('déchiffrement entrant — sérialisation par session', () => {
  it('sérialise deux messages simultanés de la même session', async () => {
    const fixture = await seeded();
    const gate = deferred();
    const seen: string[] = [];
    cryptoMock.secureDecrypt.mockImplementation(async (pickle: string) => {
      seen.push(pickle);
      if (pickle === 'S0') await gate.promise;
      return decrypted(pickle === 'S0' ? 'S1' : 'S2') as never;
    });

    const first = decrypt(fixture, incoming({ id: 'm1' }));
    const second = decrypt(fixture, incoming({ id: 'm2' }));
    await tick();

    // Le second attend : il ne peut pas partir du même S0.
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);

    expect(seen).toEqual(['S0', 'S1']);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S2' },
    ]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages ORDER BY id')).toEqual([
      { id: 'm1' },
      { id: 'm2' },
    ]);
  });

  it('laisse deux appareils distincts du même pair indépendants', async () => {
    const fixture = await seeded([
      { peer: 'peer-1', device: 'dev-1', pickle: 'A0' },
      { peer: 'peer-1', device: 'dev-2', pickle: 'B0' },
    ]);
    const gate = deferred();
    cryptoMock.secureDecrypt.mockImplementation(async (pickle: string) => {
      await gate.promise;
      return decrypted(`${pickle}+`) as never;
    });

    const first = decrypt(fixture, incoming({ id: 'm1', senderDeviceId: 'dev-1' }));
    const second = decrypt(fixture, incoming({ id: 'm2', senderDeviceId: 'dev-2' }));
    await tick();

    // Les deux sont entrés dans le déchiffrement : aucun verrou partagé à tort.
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([first, second]);
    expect(
      read(fixture, 'SELECT peer_device_id, session_pickle FROM e2ee_sessions ORDER BY peer_device_id'),
    ).toEqual([
      { peer_device_id: 'dev-1', session_pickle: 'A0+' },
      { peer_device_id: 'dev-2', session_pickle: 'B0+' },
    ]);
  });

  it('laisse deux pairs distincts indépendants', async () => {
    const fixture = await seeded([
      { peer: 'peer-1', device: 'dev-1', pickle: 'A0' },
      { peer: 'peer-2', device: 'dev-1', pickle: 'B0' },
    ]);
    const gate = deferred();
    cryptoMock.secureDecrypt.mockImplementation(async (pickle: string) => {
      await gate.promise;
      return decrypted(`${pickle}+`) as never;
    });

    const first = decrypt(fixture, incoming({ id: 'm1' }));
    const second = decrypt(
      fixture,
      incoming({
        id: 'm2',
        sender: { id: 'peer-2', displayName: 'Autre' } as unknown as Message['sender'],
      }),
    );
    await tick();
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([first, second]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions ORDER BY peer_user_id')).toEqual([
      { session_pickle: 'A0+' },
      { session_pickle: 'B0+' },
    ]);
  });

  it('libère le verrou après une erreur de déchiffrement', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt
      .mockRejectedValueOnce(new Error('bad_mac'))
      .mockResolvedValueOnce(decrypted('S1') as never);

    await expect(decrypt(fixture, incoming({ id: 'm1' }))).rejects.toThrow('bad_mac');
    // Toujours utilisable : le verrou n'est pas resté pris.
    const ok = await decrypt(fixture, incoming({ id: 'm2' }));
    expect(ok.text).toBe('bonjour');
  });

  it('partage réellement le verrou avec le chemin sortant', async () => {
    const fixture = await seeded();
    const held = deferred();
    const release = deferred();
    const holder = withOlmLock(
      { accountId: 'local-identity', peerUserId: 'peer-1', peerDeviceId: 'dev-1' },
      async () => {
        held.resolve();
        await release.promise;
      },
    );
    await held.promise;

    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);
    const pending = decrypt(fixture, incoming({ id: 'm1' }));
    await tick();
    // Même clé que `encryptEnvelope` : le message attend la session.
    expect(cryptoMock.secureDecrypt).not.toHaveBeenCalled();

    release.resolve();
    await holder;
    await pending;
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);
  });
});

describe('déchiffrement entrant — persistance atomique', () => {
  it('persiste la session avancée et le message ensemble', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1', 'salut') as never);

    const result = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(result.text).toBe('salut');
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    expect(read(fixture, 'SELECT id, body, mine FROM e2ee_messages')).toEqual([
      { id: 'm1', body: 'salut', mine: 0 },
    ]);
  });

  it('ne réécrit pas le pickle de compte sur une session existante', async () => {
    const fixture = await seeded();
    // État global déjà avancé par un autre pair : il ne doit pas être écrasé
    // par la copie périmée que porte l'appelant.
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_account
         (id, account_pickle, device_id, identity_key, signing_key, created_at)
       VALUES (1, 'account-avance', 'local-device', 'local-identity', 'local-signing',
               '2026-01-01T00:00:00Z')`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);

    await decrypt(fixture, incoming({ id: 'm1' }));

    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([
      { account_pickle: 'account-avance' },
    ]);
  });

  it('annule tout si la transaction prekey échoue sur le compte', async () => {
    const fixture = await seeded([]);
    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-2',
      session_pickle: 'S1',
      plaintext_b64: plaintext('premier'),
    } as never);
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE INSERT ON e2ee_account
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    await expect(decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' }))).rejects.toThrow(
      'boom',
    );
    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
  });

  it('ne laisse aucune session avancée quand la transaction échoue', async () => {
    const fixture = await seeded();
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE INSERT ON e2ee_messages
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);

    await expect(decrypt(fixture, incoming({ id: 'm1' }))).rejects.toThrow('boom');

    // S1 a bien été calculé, mais rien n'a été écrit : la base reste à S0.
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
  });

  it('annule le message déjà écrit quand l’écriture de session échoue', async () => {
    const fixture = await seeded();
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE UPDATE ON e2ee_sessions
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);

    await expect(decrypt(fixture, incoming({ id: 'm1' }))).rejects.toThrow('boom');
    // Message et session annulés ensemble : jamais l'un sans l'autre.
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
  });

  it('écrit dans la même transaction que le message (helper dédié)', async () => {
    const fixture = await seeded();
    await expect(
      persistIncoming({
        db: fixture.db,
        session: {
          peer_user_id: 'peer-1',
          peer_device_id: 'dev-1',
          session_pickle: 'S9',
          peer_identity_key: 'peer-ident',
          peer_signing_key: 'peer-sign',
          updated_at: '2026-01-02T00:00:00Z',
        },
        account,
        message: {
          id: 'm9',
          conversation_id: 'conv-1',
          sender_id: 'peer-1',
          sender_name: 'Pair',
          body: 'x',
          created_at: '2026-01-02T00:00:00Z',
          client_id: null,
          mine: 0,
          media_meta: null,
          quote_id: null,
        },
        pinPeerKey: true,
      }),
    ).resolves.toEqual({});
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S9' },
    ]);
    expect(read(fixture, 'SELECT signing_key FROM e2ee_peer_keys')).toEqual([
      { signing_key: 'peer-sign' },
    ]);
  });
});

describe('déchiffrement entrant — doublons', () => {
  it('traite un doublon sans consommer une seconde clé de ratchet', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1', 'salut') as never);

    const first = await decrypt(fixture, incoming({ id: 'm1' }));
    const again = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(first.text).toBe('salut');
    expect(again.text).toBe('salut');
    expect(again.keyChanged).toBe(false);
    // Un seul déchiffrement, une seule avancée de session, une seule ligne.
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([{ id: 'm1' }]);
  });

  it('ne duplique pas la ligne quand deux copies arrivent en parallèle', async () => {
    const fixture = await seeded();
    const gate = deferred();
    cryptoMock.secureDecrypt.mockImplementation(async () => {
      await gate.promise;
      return decrypted('S1') as never;
    });

    const first = decrypt(fixture, incoming({ id: 'm1' }));
    const second = decrypt(fixture, incoming({ id: 'm1' }));
    await tick();
    gate.resolve();
    await Promise.allSettled([first, second]);

    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([{ id: 'm1' }]);
  });
});

describe('déchiffrement entrant — repli prekey', () => {
  it('récupère le bundle hors verrou et ouvre la session', async () => {
    const fixture = await seeded([]);
    const held = deferred();
    const release = deferred();
    const holder = withOlmLock(
      { accountId: 'local-identity', peerUserId: 'peer-1', peerDeviceId: 'dev-1' },
      async () => {
        held.resolve();
        await release.promise;
      },
    );
    await held.promise;

    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-2',
      session_pickle: 'S1',
      plaintext_b64: plaintext('premier'),
    } as never);

    const pending = decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' }));
    await tick();
    // Le réseau a lieu alors que le verrou est détenu par un autre : il ne
    // bloque donc pas et n'est jamais fait sous verrou.
    expect(apiMock.getE2eeKeyBundle).toHaveBeenCalledTimes(1);
    expect(cryptoMock.secureCreateInbound).not.toHaveBeenCalled();

    release.resolve();
    await holder;
    const result = await pending;

    expect(result.text).toBe('premier');
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    // La prekey consommée avance le compte, dans la même transaction.
    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([
      { account_pickle: 'account-2' },
    ]);
  });

  it('ne consomme la prekey qu’une fois pour un doublon', async () => {
    const fixture = await seeded([]);
    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-2',
      session_pickle: 'S1',
      plaintext_b64: plaintext('premier'),
    } as never);

    await decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' }));
    await decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' }));

    expect(cryptoMock.secureCreateInbound).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([{ id: 'm1' }]);
  });

  it('déchiffre par la session quand elle existe déjà', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);

    const result = await decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' }));
    expect(result.text).toBe('bonjour');
    expect(apiMock.getE2eeKeyBundle).not.toHaveBeenCalled();
  });
});

describe('decryptEnvelope — primitive sans écriture', () => {
  it('renvoie la session avancée sans rien persister', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);

    const opened = await decryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      message: incoming({ id: 'm1' }),
    });

    expect(opened.session.session_pickle).toBe('S1');
    // Tant que l'appelant n'écrit pas, la base n'a pas bougé.
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
  });
});

describe('déchiffrement entrant — pickle global du compte', () => {
  /** Faux crypto : le pickle de compte accumule ce qui a été consommé. */
  const accountAppending = () => {
    cryptoMock.secureCreateInbound.mockImplementation(async (pickle: string, identity: string) => ({
      account_pickle: `${pickle}>${identity}`,
      session_pickle: `S-${identity}`,
      plaintext_b64: plaintext(identity),
    }) as never);
  };

  const prekey = (id: string, peer: string) =>
    incoming({
      id,
      payloadType: 'prekey',
      sender: { id: peer, displayName: peer } as unknown as Message['sender'],
    });

  it('ne perd aucune consommation quand deux pairs ouvrent une session à la fois', async () => {
    const fixture = await seeded([]);
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_account
         (id, account_pickle, device_id, identity_key, signing_key, created_at)
       VALUES (1, 'A0', 'local-device', 'local-identity', 'local-signing',
               '2026-01-01T00:00:00Z')`,
    );
    accountAppending();
    apiMock.getE2eeKeyBundle.mockImplementation(async (_token: string, peerId: string) => ({
      deviceId: 'dev-1',
      identityKey: `ident-${peerId}`,
      signingKey: `sign-${peerId}`,
      signedPrekey: null,
      signedPrekeySignature: null,
      oneTimeKey: null,
      fallback: null,
    }));

    // Deux pairs différents : le verrou de session ne les sérialise pas, seul
    // le verrou de compte les met en file.
    await Promise.all([
      decrypt(fixture, prekey('m1', 'peer-1')),
      decrypt(fixture, prekey('m2', 'peer-2')),
    ]);

    // Les deux avancées sont conservées : aucune prekey consommée n'est perdue.
    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([
      { account_pickle: 'A0>ident-peer-1>ident-peer-2' },
    ]);
    expect(read(fixture, 'SELECT peer_user_id FROM e2ee_sessions ORDER BY peer_user_id')).toEqual([
      { peer_user_id: 'peer-1' },
      { peer_user_id: 'peer-2' },
    ]);
  });

  it('part du pickle relu et non de la copie de l’appelant', async () => {
    const fixture = await seeded([]);
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_account
         (id, account_pickle, device_id, identity_key, signing_key, created_at)
       VALUES (1, 'A-plus-recent', 'local-device', 'local-identity', 'local-signing',
               '2026-01-01T00:00:00Z')`,
    );
    accountAppending();

    await decrypt(fixture, prekey('m1', 'peer-1'));

    // `account` (A0 côté appelant) a été ignoré au profit de la base.
    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([
      { account_pickle: 'A-plus-recent>peer-ident' },
    ]);
  });

  it('attend le verrou de compte sans bloquer les autres pairs', async () => {
    const fixture = await seeded();
    const held = deferred();
    const release = deferred();
    const holder = withAccountLock('local-identity', async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;

    accountAppending();
    cryptoMock.secureDecrypt.mockResolvedValue(decrypted('S1') as never);

    // Session déjà ouverte : le déchiffrement n'a pas besoin du verrou de compte.
    const existing = await decrypt(fixture, incoming({ id: 'm1' }));
    expect(existing.text).toBe('bonjour');

    // Ouverture prekey, elle, attend le verrou de compte.
    const pending = decrypt(fixture, prekey('m2', 'peer-9'));
    await tick();
    expect(cryptoMock.secureCreateInbound).not.toHaveBeenCalled();
    release.resolve();
    await holder;
    await pending;
    expect(cryptoMock.secureCreateInbound).toHaveBeenCalledTimes(1);
  });

  it('libère le verrou de compte après un échec', async () => {
    const fixture = await seeded([]);
    cryptoMock.secureCreateInbound
      .mockRejectedValueOnce(new Error('SessionCreation'))
      .mockResolvedValueOnce({
        account_pickle: 'A1',
        session_pickle: 'S1',
        plaintext_b64: plaintext('ok'),
      } as never);

    await expect(decrypt(fixture, prekey('m1', 'peer-1'))).rejects.toThrow('SessionCreation');
    await expect(decrypt(fixture, prekey('m2', 'peer-2'))).resolves.toMatchObject({ text: 'ok' });
  });
});

describe('déchiffrement entrant — stickers v3', () => {
  const KNOWN = 'mbolo-panther-2d/amour';

  it('persiste un sticker connu : corps vide, référence, pas de média', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', KNOWN) as never);

    const result = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(result.stickerRef).toBe(KNOWN);
    expect(result.text).toBe('');
    expect(result.media).toBeUndefined();
    expect(result.stored.sticker_ref).toBe(KNOWN);
    expect(read(fixture, 'SELECT id, body, media_meta, quote_id, sticker_ref FROM e2ee_messages'))
      .toEqual([
        {
          id: 'm1',
          body: '',
          media_meta: null,
          quote_id: null,
          sticker_ref: KNOWN,
        },
      ]);
    // La session a bien avancé dans la même écriture.
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
  });

  it('accepte et persiste une référence valide absente du catalogue local', async () => {
    const fixture = await seeded();
    const future = 'mbolo-panther-3d/inconnu-a-ce-jour';
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', future) as never);

    const result = await decrypt(fixture, incoming({ id: 'm2' }));

    // Le parser valide la forme, pas l'existence : l'affichage décide du repli.
    expect(result.stickerRef).toBe(future);
    expect(read(fixture, 'SELECT body, sticker_ref FROM e2ee_messages')).toEqual([
      { body: '', sticker_ref: future },
    ]);
  });

  it('refuse une référence mal formée en message illisible, sans casser le ratchet', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(
      decryptedSticker('S1', 'https://exemple.test/sticker.png') as never,
    );

    const result = await decrypt(fixture, incoming({ id: 'm3' }));

    // La charge utile est authentifiée mais hors contrat : elle devient un
    // message illisible plutôt qu'une erreur qui laisserait la session en
    // arrière (protection P0). La référence invalide n'est jamais conservée.
    expect(result.unreadableReason).toBe('invalid_payload');
    expect(read(fixture, 'SELECT sticker_ref, unreadable_reason FROM e2ee_messages')).toEqual([
      { sticker_ref: null, unreadable_reason: 'invalid_payload' },
    ]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
  });

  it('conserve replyTo quand le sticker cite un message', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(
      decryptedSticker('S1', KNOWN, 'msg-cite') as never,
    );

    const result = await decrypt(fixture, incoming({ id: 'm4' }));

    expect(result.stickerRef).toBe(KNOWN);
    expect(read(fixture, 'SELECT quote_id, body FROM e2ee_messages')).toEqual([
      { quote_id: 'msg-cite', body: '' },
    ]);
  });

  it('ne duplique pas un sticker reçu deux fois et ne reconsomme pas le ratchet', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', KNOWN) as never);

    const first = await decrypt(fixture, incoming({ id: 'm5' }));
    const again = await decrypt(fixture, incoming({ id: 'm5' }));

    expect(first.stickerRef).toBe(KNOWN);
    // Le rejeu retrouve la référence déjà stockée.
    expect(again.stickerRef).toBe(KNOWN);
    expect(again.keyChanged).toBe(false);
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT sticker_ref FROM e2ee_messages')).toEqual([{ sticker_ref: KNOWN }]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
  });

  it('annule message et session quand l écriture du message échoue, puis réussit au retry', async () => {
    const fixture = await seeded();
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE INSERT ON e2ee_messages
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', KNOWN) as never);

    await expect(decrypt(fixture, incoming({ id: 'm6' }))).rejects.toThrow('boom');
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);

    // Le pair renvoie le message : la nouvelle tentative part du même état S0 et
    // persiste cette fois la référence, sans doublon.
    await fixture.handle.execAsync('DROP TRIGGER boom');
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', KNOWN) as never);
    const retried = await decrypt(fixture, incoming({ id: 'm6' }));

    expect(retried.stored.sticker_ref).toBe(KNOWN);
    expect(read(fixture, 'SELECT id, sticker_ref FROM e2ee_messages')).toEqual([
      { id: 'm6', sticker_ref: KNOWN },
    ]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
  });

  it('annule la ligne de sticker quand l écriture de session échoue', async () => {
    const fixture = await seeded();
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE UPDATE ON e2ee_sessions
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', KNOWN) as never);

    await expect(decrypt(fixture, incoming({ id: 'm7' }))).rejects.toThrow('boom');
    // Aucune demi-persistance : le sticker ne survit pas sans la session.
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
  });

  it('annule tout quand le pickle de compte d un sticker prekey échoue', async () => {
    const fixture = await seeded([]);
    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-2',
      session_pickle: 'S1',
      plaintext_b64: stickerPlain(KNOWN),
    } as never);
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE INSERT ON e2ee_account
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    await expect(
      decrypt(fixture, incoming({ id: 'm8', payloadType: 'prekey' })),
    ).rejects.toThrow('boom');
    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
  });

  it('garde la référence dans la seule base chiffrée, sans appel réseau', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedSticker('S1', KNOWN) as never);

    await decrypt(fixture, incoming({ id: 'm9' }));

    // Aucun aller-retour : la session locale suffit, rien n'est demandé au serveur.
    expect(apiMock.getE2eeKeyBundle).not.toHaveBeenCalled();
    expect(vi.mocked(socketModule.ensureSocket)).not.toHaveBeenCalled();

    // La référence n'existe que dans `e2ee_messages` (SQLCipher). Aucun autre
    // stockage local ne la reçoit.
    const dump = [
      ...read(fixture, 'SELECT * FROM e2ee_drafts'),
      ...read(fixture, 'SELECT * FROM e2ee_outbox'),
      ...read(fixture, 'SELECT * FROM e2ee_media_prep'),
      ...read(fixture, 'SELECT peer_user_id, session_pickle FROM e2ee_sessions'),
      ...read(fixture, 'SELECT account_pickle FROM e2ee_account'),
      ...read(fixture, 'SELECT peer_user_id, signing_key FROM e2ee_peer_keys'),
    ];
    expect(JSON.stringify(dump)).not.toContain(KNOWN);
    expect(read(fixture, 'SELECT sticker_ref FROM e2ee_messages')).toEqual([
      { sticker_ref: KNOWN },
    ]);
  });
});

describe('déchiffrement entrant — réactions v4', () => {
  it('stocke une réaction masquée même si la cible est inconnue', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(decryptedReaction('S1', 'inconnu-1') as never);

    const result = await decrypt(fixture, incoming({ id: 'r1' }));

    expect(result.hidden).toBe(true);
    expect(result.reactionEvent).toEqual({
      targetId: 'inconnu-1',
      reaction: 'mbolo-panther-2d/amour',
      action: 'add',
      authorId: 'peer-1',
    });
    expect(
      read(
        fixture,
        `SELECT body, hidden, content_kind, control_target, reaction, reaction_action
           FROM e2ee_messages WHERE id = 'r1'`,
      ),
    ).toEqual([
      {
        body: '',
        hidden: 1,
        content_kind: 'reaction',
        control_target: 'inconnu-1',
        reaction: 'mbolo-panther-2d/amour',
        reaction_action: 'add',
      },
    ]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages WHERE COALESCE(hidden, 0) = 0')).toEqual([]);
  });

  it('agrège par auteur, sans double comptage, et applique le retrait', async () => {
    const fixture = await seeded();
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_messages
         (id, conversation_id, sender_id, sender_name, body, created_at, client_id, mine)
       VALUES ('m1', 'conv-1', 'peer-1', 'Pair', 'bonjour', '2026-01-01T00:00:00Z', NULL, 0)`,
    );
    cryptoMock.secureDecrypt
      .mockResolvedValueOnce(decryptedReaction('S1', 'm1') as never)
      .mockResolvedValueOnce(decryptedReaction('S2', 'm1') as never)
      .mockResolvedValueOnce(decryptedReaction('S3', 'm1', 'mbolo-panther-2d/amour', 'remove') as never);

    await decrypt(fixture, incoming({ id: 'r1' }));
    let summaries = await loadReactionSummaries(fixture.db, 'conv-1', 'me');
    expect(summaries.get('m1')).toEqual([
      { reaction: 'mbolo-panther-2d/amour', count: 1, mine: false },
    ]);

    await decrypt(fixture, incoming({ id: 'r2' }));
    summaries = await loadReactionSummaries(fixture.db, 'conv-1', 'me');
    expect(summaries.get('m1')?.[0]?.count).toBe(1);

    await decrypt(fixture, incoming({ id: 'r3' }));
    summaries = await loadReactionSummaries(fixture.db, 'conv-1', 'me');
    expect(summaries.has('m1')).toBe(false);
  });

  it('respecte l’ordre d’arrivée à horodatage égal, pas l’ordre lexical des identifiants', async () => {
    const fixture = await seeded();
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_messages
         (id, conversation_id, sender_id, sender_name, body, created_at, client_id, mine)
       VALUES ('m1', 'conv-1', 'peer-1', 'Pair', 'bonjour', '2026-01-01T00:00:00Z', NULL, 0)`,
    );
    cryptoMock.secureDecrypt
      .mockResolvedValueOnce(decryptedReaction('S1', 'm1') as never)
      .mockResolvedValueOnce(decryptedReaction('S2', 'm1', 'mbolo-panther-2d/amour', 'remove') as never);

    await decrypt(fixture, incoming({ id: 'z-reaction' }));
    await decrypt(fixture, incoming({ id: 'a-reaction' }));

    const summaries = await loadReactionSummaries(fixture.db, 'conv-1', 'me');
    expect(summaries.has('m1')).toBe(false);
  });

  it('ne rejoue pas un doublon et rejette une réaction mal formée sans bruit', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValueOnce(decryptedReaction('S1', 'm1') as never);
    const first = await decrypt(fixture, incoming({ id: 'r1' }));
    const duplicate = await decrypt(fixture, incoming({ id: 'r1' }));
    expect(duplicate.reactionEvent).toEqual(first.reactionEvent);
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);

    cryptoMock.secureDecrypt.mockResolvedValueOnce({
      ...decrypted('S2'),
      plaintext_b64: Buffer.from(
        JSON.stringify({
          v: 4,
          kind: 'reaction',
          targetId: 'm1',
          reaction: 'texte libre',
          action: 'add',
        }),
        'utf8',
      ).toString('base64'),
    } as never);
    const malformed = await decrypt(fixture, incoming({ id: 'r2' }));
    expect(malformed.hidden).toBe(true);
    expect(malformed.unreadableReason).toBe('invalid_payload');
    expect(malformed.reactionEvent).toBeUndefined();
  });
});

describe('déchiffrement entrant — suppression pour tous v5', () => {
  const seedTarget = async (fixture: Fixture) => {
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_messages
         (id, conversation_id, sender_id, sender_name, body, created_at, client_id, mine,
          media_meta, quote_id, sticker_ref)
       VALUES ('m1', 'conv-1', 'peer-1', 'Pair', 'secret', '2026-01-01T00:00:00Z', NULL, 0,
               '{"type":"IMAGE"}', 'cited-1', 'mbolo-panther-2d/amour')`,
    );
  };

  it('vide la cible uniquement quand l’auteur du message la supprime', async () => {
    const fixture = await seeded();
    await seedTarget(fixture);
    cryptoMock.secureDecrypt.mockResolvedValueOnce(decryptedDelete('S1', 'm1') as never);

    const result = await decrypt(fixture, incoming({ id: 'd1' }));

    expect(result.deletionEvent).toMatchObject({
      targetId: 'm1',
      authorId: 'peer-1',
      applied: true,
    });
    expect(
      read(
        fixture,
        `SELECT body, media_meta, quote_id, sticker_ref, deleted, deleted_by
           FROM e2ee_messages WHERE id = 'm1'`,
      ),
    ).toEqual([
      {
        body: '',
        media_meta: null,
        quote_id: null,
        sticker_ref: null,
        deleted: 1,
        deleted_by: 'peer-1',
      },
    ]);
  });

  it('ignore une suppression demandée par un autre auteur', async () => {
    const fixture = await seeded([
      { peer: 'peer-1', device: 'dev-1', pickle: 'S0' },
      { peer: 'peer-2', device: 'dev-2', pickle: 'T0' },
    ]);
    await seedTarget(fixture);
    cryptoMock.secureDecrypt.mockResolvedValueOnce(decryptedDelete('T1', 'm1') as never);

    const result = await decrypt(
      fixture,
      incoming({
        id: 'd1',
        senderDeviceId: 'dev-2',
        sender: { id: 'peer-2', displayName: 'Autre' } as unknown as Message['sender'],
      }),
    );

    expect(result.deletionEvent).toMatchObject({ applied: false, authorId: 'peer-2' });
    expect(
      read(fixture, `SELECT body, deleted FROM e2ee_messages WHERE id = 'm1'`),
    ).toEqual([{ body: 'secret', deleted: 0 }]);
  });

  it('applique une tombstone reçue avant sa cible, dans la transaction d’arrivée', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt
      .mockResolvedValueOnce(decryptedDelete('S1', 'future-message') as never)
      .mockResolvedValueOnce(decrypted('S2', 'arrive après') as never);

    const deletion = await decrypt(fixture, incoming({ id: 'd1' }));
    expect(deletion.deletionEvent).toMatchObject({ applied: false, targetId: 'future-message' });
    expect(read(fixture, 'SELECT target_id, author_id FROM e2ee_deletions')).toEqual([
      { target_id: 'future-message', author_id: 'peer-1' },
    ]);

    const target = await decrypt(fixture, incoming({ id: 'future-message' }));
    expect(target.stored).toMatchObject({ deleted: 1, body: '', deleted_by: 'peer-1' });
    expect(
      read(fixture, `SELECT body, deleted FROM e2ee_messages WHERE id = 'future-message'`),
    ).toEqual([{ body: '', deleted: 1 }]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S2' },
    ]);
  });

  it('n’applique ni immédiatement ni par tombstone une suppression d’une autre conversation', async () => {
    const fixture = await seeded();
    await seedTarget(fixture);
    cryptoMock.secureDecrypt
      .mockResolvedValueOnce(decryptedDelete('S1', 'm1') as never)
      .mockResolvedValueOnce(decryptedDelete('S2', 'future-message') as never)
      .mockResolvedValueOnce(decrypted('S3', 'arrive après') as never);

    const immediate = await decrypt(fixture, incoming({ id: 'd1', conversationId: 'conv-2' }));
    expect(immediate.deletionEvent).toMatchObject({ targetId: 'm1', applied: false });
    expect(read(fixture, `SELECT body, deleted FROM e2ee_messages WHERE id = 'm1'`)).toEqual([
      { body: 'secret', deleted: 0 },
    ]);

    await decrypt(fixture, incoming({ id: 'd2', conversationId: 'conv-2' }));
    const target = await decrypt(fixture, incoming({ id: 'future-message', conversationId: 'conv-1' }));
    expect(target.stored).toMatchObject({ body: 'arrive après' });
    expect(read(fixture, `SELECT deleted FROM e2ee_messages WHERE id = 'future-message'`)).toEqual([
      { deleted: 0 },
    ]);
  });

  it('rend un doublon inoffensif et masque une suppression mal formée', async () => {
    const fixture = await seeded();
    await seedTarget(fixture);
    cryptoMock.secureDecrypt.mockResolvedValueOnce(decryptedDelete('S1', 'm1') as never);
    await decrypt(fixture, incoming({ id: 'd1' }));
    const duplicate = await decrypt(fixture, incoming({ id: 'd1' }));
    expect(duplicate.deletionEvent).toMatchObject({ targetId: 'm1', applied: false });
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);

    cryptoMock.secureDecrypt.mockResolvedValueOnce({
      ...decrypted('S2'),
      plaintext_b64: Buffer.from(
        JSON.stringify({ v: 5, kind: 'delete', targetId: '../m1', authorId: 'peer-1' }),
        'utf8',
      ).toString('base64'),
    } as never);
    const malformed = await decrypt(fixture, incoming({ id: 'd2' }));
    expect(malformed.hidden).toBe(true);
    expect(malformed.unreadableReason).toBe('invalid_payload');
    expect(malformed.deletionEvent).toBeUndefined();
  });
});

/**
 * Lot A — protection P0 : un contenu **authentifié mais illisible** (le
 * déchiffrement Olm a réussi, le parsing échoue) doit être persisté comme
 * message illisible **dans la même transaction** que l'état de session avancé.
 *
 * Le risque visé n'est pas le message perdu mais la conversation : sans cette
 * écriture, la session restait en arrière pendant que l'expéditeur avançait son
 * ratchet, et tous les messages suivants devenaient indéchiffrables.
 */
describe('message authentifié mais illisible — le ratchet avance quand même', () => {
  /** Base64 de la charge utile telle qu'elle sortirait du déchiffrement. */
  const plainOf = (value: unknown) =>
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString(
      'base64',
    );

  const unreadableOf = (pickle: string, payload: string) => ({
    ...decrypted(pickle),
    plaintext_b64: payload,
  });

  const messageRow = (fixture: Fixture, id: string) =>
    read(
      fixture,
      `SELECT body, media_meta, quote_id, sticker_ref, unreadable_reason
         FROM e2ee_messages WHERE id = ?`,
      id,
    );

  const sessionPickle = (fixture: Fixture) =>
    read(fixture, 'SELECT session_pickle FROM e2ee_sessions ORDER BY peer_device_id');

  /**
   * Faux ratchet : un pickle n'est accepté qu'une fois. Rejouer un état déjà
   * consommé échoue comme le ferait Olm (`wrong_ratchet_state`), ce qui rend le
   * test décisif : il échoue si la session n'a pas vraiment été persistée.
   */
  function ratchetMock(plaintextByPayload: (payload: string) => string) {
    const state = { current: 'S0' };
    cryptoMock.secureDecrypt.mockImplementation(async (pickle: string, _type, payload) => {
      if (pickle !== state.current) throw new Error('wrong_ratchet_state');
      state.current = `${pickle}+1`;
      return {
        session_pickle: state.current,
        session_id: 'sid',
        message_type: 'normal',
        plaintext_b64: plaintextByPayload(String(payload)),
      } as never;
    });
    return state;
  }

  it('persiste un placeholder pour une version future et avance la session', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(
      unreadableOf('S1', plainOf({ v: 6, kind: 'sticker', stickerRef: 'pack/id' })) as never,
    );

    const result = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(result.unreadableReason).toBe('unsupported_version');
    expect(result.text).toBe('');
    expect(result.media).toBeUndefined();
    expect(result.stickerRef).toBeUndefined();
    // Rien du payload n'est conservé : le message est un marqueur, pas un contenu.
    expect(messageRow(fixture, 'm1')).toEqual([
      {
        body: '',
        media_meta: null,
        quote_id: null,
        sticker_ref: null,
        unreadable_reason: 'unsupported_version',
      },
    ]);
    // Le point capital : la session a bien avancé.
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S1' }]);
  });

  it('classe un JSON invalide en invalid_payload', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(unreadableOf('S1', plainOf('{pas du json')) as never);

    const result = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(result.unreadableReason).toBe('invalid_payload');
    expect(messageRow(fixture, 'm1')[0]).toMatchObject({ unreadable_reason: 'invalid_payload' });
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S1' }]);
  });

  it('classe un contrat v1 sans texte en invalid_payload', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(unreadableOf('S1', plainOf({ v: 1 })) as never);

    const result = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(result.unreadableReason).toBe('invalid_payload');
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S1' }]);
  });

  it('classe un encodage illisible en invalid_encoding', async () => {
    const fixture = await seeded();
    // Octets qui ne forment pas de l'UTF-8 valide : le JSON est inatteignable.
    cryptoMock.secureDecrypt.mockResolvedValue(
      unreadableOf('S1', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')) as never,
    );

    const result = await decrypt(fixture, incoming({ id: 'm1' }));

    expect(result.unreadableReason).toBe('invalid_encoding');
    expect(messageRow(fixture, 'm1')[0]).toMatchObject({ unreadable_reason: 'invalid_encoding' });
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S1' }]);
  });

  it('ne transforme jamais un échec cryptographique en placeholder', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockRejectedValue(new Error('bad mac'));

    await expect(decrypt(fixture, incoming({ id: 'm1' }))).rejects.toThrow('bad mac');

    // Un MAC invalide ne prouve rien sur le contenu : aucune ligne, aucune avancée.
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S0' }]);
  });

  it('test décisif : le message suivant reste déchiffrable après un contenu illisible', async () => {
    const fixture = await seeded();
    const state = ratchetMock((payload) =>
      payload === 'ILLISIBLE' ? plainOf({ v: 6, kind: 'sticker' }) : plainOf({ v: 1, text: 'bonjour' }),
    );

    const first = await decrypt(fixture, incoming({ id: 'm1', payload: 'ILLISIBLE' }));
    expect(first.unreadableReason).toBe('unsupported_version');
    expect(state.current).toBe('S0+1');
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S0+1' }]);

    // Deuxième message de la **même** session : il ne peut être ouvert que
    // depuis l'état persisté par le premier (le faux ratchet refuse S0).
    const second = await decrypt(fixture, incoming({ id: 'm2', payload: 'VALIDE' }));
    expect(second.text).toBe('bonjour');
    expect(state.current).toBe('S0+1+1');
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S0+1+1' }]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages ORDER BY id')).toEqual([
      { id: 'm1' },
      { id: 'm2' },
    ]);
  });

  it('un échec de déchiffrement n’avance pas le ratchet (contraste du test décisif)', async () => {
    const fixture = await seeded();
    const state = ratchetMock((payload) => plainOf({ v: 1, text: payload }));
    // Le premier message échoue avant tout déchiffrement réussi.
    cryptoMock.secureDecrypt.mockRejectedValueOnce(new Error('bad mac'));

    await expect(decrypt(fixture, incoming({ id: 'm1', payload: 'X' }))).rejects.toThrow('bad mac');
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S0' }]);

    // Reprise normale : le ratchet n'a pas bougé, le message passe depuis S0.
    const retried = await decrypt(fixture, incoming({ id: 'm1', payload: 'X' }));
    expect(retried.text).toBe('X');
    expect(state.current).toBe('S0+1');
  });

  it('reconnaît le doublon d’un message illisible sans rejouer le ratchet', async () => {
    const fixture = await seeded();
    cryptoMock.secureDecrypt.mockResolvedValue(unreadableOf('S1', plainOf({ v: 9 })) as never);

    await decrypt(fixture, incoming({ id: 'm1' }));
    const again = await decrypt(fixture, incoming({ id: 'm1' }));

    // Un seul déchiffrement, une seule ligne, une seule avancée.
    expect(cryptoMock.secureDecrypt).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([{ id: 'm1' }]);
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S1' }]);
    expect(again.unreadableReason).toBe('unsupported_version');
    expect(again.text).toBe('');
  });

  it('annule placeholder et session quand l’écriture du message échoue', async () => {
    const fixture = await seeded();
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE INSERT ON e2ee_messages
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(unreadableOf('S1', plainOf({ v: 7 })) as never);

    await expect(decrypt(fixture, incoming({ id: 'm1' }))).rejects.toThrow('boom');

    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S0' }]);
  });

  it('annule le placeholder quand l’écriture de session échoue', async () => {
    const fixture = await seeded();
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE UPDATE ON e2ee_sessions
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureDecrypt.mockResolvedValue(unreadableOf('S1', plainOf({ v: 7 })) as never);

    await expect(decrypt(fixture, incoming({ id: 'm1' }))).rejects.toThrow('boom');

    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
    expect(sessionPickle(fixture)).toEqual([{ session_pickle: 'S0' }]);
  });

  it('annule tout quand la prekey d’un message illisible échoue sur le compte', async () => {
    const fixture = await seeded([]);
    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-2',
      session_pickle: 'S1',
      plaintext_b64: plainOf({ v: 6 }),
    } as never);
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE INSERT ON e2ee_account
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    await expect(
      decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' })),
    ).rejects.toThrow('boom');

    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
  });

  it('annule tout quand l’épinglage de clé échoue sur un message illisible', async () => {
    const fixture = await seeded([]);
    // Clé connue différente du bundle : la clé du pair doit être réépinglée.
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_peer_keys (peer_user_id, peer_device_id, signing_key, verified, updated_at)
       VALUES ('peer-1', 'dev-1', 'ancienne-cle', 1, '2026-01-01T00:00:00Z')`,
    );
    await fixture.handle.execAsync(
      `CREATE TRIGGER boom BEFORE UPDATE ON e2ee_peer_keys
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    cryptoMock.secureCreateInbound.mockResolvedValue({
      account_pickle: 'account-2',
      session_pickle: 'S1',
      plaintext_b64: plainOf({ v: 6 }),
    } as never);

    await expect(
      decrypt(fixture, incoming({ id: 'm1', payloadType: 'prekey' })),
    ).rejects.toThrow('boom');

    expect(read(fixture, 'SELECT account_pickle FROM e2ee_account')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([]);
    expect(read(fixture, 'SELECT id FROM e2ee_messages')).toEqual([]);
    expect(read(fixture, 'SELECT signing_key FROM e2ee_peer_keys')).toEqual([
      { signing_key: 'ancienne-cle' },
    ]);
  });

  it('n’expose ni le payload ni la clé : seul un motif normalisé est stocké', async () => {
    const fixture = await seeded();
    const marqueur = 'SECRET-DU-PAYLOAD-42';
    cryptoMock.secureDecrypt.mockResolvedValue(
      unreadableOf('S1', plainOf({ v: 5, text: marqueur })) as never,
    );

    await decrypt(fixture, incoming({ id: 'm1' }));

    const dump = [
      ...read(fixture, 'SELECT * FROM e2ee_messages'),
      ...read(fixture, 'SELECT * FROM e2ee_drafts'),
      ...read(fixture, 'SELECT * FROM e2ee_outbox'),
      ...read(fixture, 'SELECT * FROM e2ee_media_prep'),
      ...read(fixture, 'SELECT peer_user_id, session_pickle FROM e2ee_sessions'),
      ...read(fixture, 'SELECT account_pickle FROM e2ee_account'),
      ...read(fixture, 'SELECT peer_user_id, signing_key FROM e2ee_peer_keys'),
    ];
    expect(JSON.stringify(dump)).not.toContain(marqueur);
    // Motif dans la liste fermée, jamais un message d'exception.
    expect(['unsupported_version', 'invalid_payload', 'invalid_encoding']).toContain(
      messageRow(fixture, 'm1')[0]?.unreadable_reason,
    );
    expect(apiMock.getE2eeKeyBundle).not.toHaveBeenCalled();
    expect(vi.mocked(socketModule.ensureSocket)).not.toHaveBeenCalled();
  });
});
