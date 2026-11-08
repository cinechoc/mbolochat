import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import type { Message } from '@/lib/types';
import { persistIncoming } from './atomic';
import type { E2eeAccountRow } from './db';
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
    ).resolves.toBeUndefined();
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
