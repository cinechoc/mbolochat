import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary } from '@/lib/types';
import { persistSessionAndEnvelope } from './atomic';
import type { E2eeAccountRow, E2eeSessionRow } from './db';
import { migrateE2eeSchema } from './schema';
import { encryptEnvelope, sendEncryptedText } from './text';

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: {
    secureEncrypt: vi.fn(),
    secureCreateOutbound: vi.fn(),
    verifyPrekey: vi.fn(),
    secureDecrypt: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: { getE2eeKeyBundle: vi.fn() } }));
vi.mock('@/lib/socket', () => ({ ensureSocket: vi.fn() }));

const cryptoMock = vi.mocked(MboloCrypto);
const apiMock = vi.mocked(api);
const socketMock = vi.mocked(ensureSocket);

/**
 * Vraie base SQLite en mémoire : ces tests valident des propriétés
 * transactionnelles (commit, rollback, atomicité) qu'un mock de `runAsync` ne
 * peut pas démontrer. `withExclusiveTransactionAsync` est émulé à l'identique
 * avec `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
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
  /** Même objet, typé `SQLiteDatabase` pour les fonctions de production. */
  db: never;
}

function openDb(): Fixture {
  const raw = new DatabaseSync(':memory:');
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
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (cause) {
        raw.exec('ROLLBACK');
        throw cause;
      }
    },
    withExclusiveTransactionAsync: async (task: (txn: Handle) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        await task(handle);
        raw.exec('COMMIT');
      } catch (cause) {
        raw.exec('ROLLBACK');
        throw cause;
      }
    },
  };
  return { raw, handle, db: handle as never };
}

const account: E2eeAccountRow = {
  account_pickle: 'account-pickle',
  device_id: 'local-device',
  identity_key: 'local-identity',
  signing_key: 'local-signing',
};

const conversation = (id: string, peerId: string): ConversationSummary =>
  ({
    id,
    type: 'DIRECT',
    members: [
      { id: 'me', displayName: 'Moi' },
      { id: peerId, displayName: 'Pair' },
    ],
  }) as unknown as ConversationSummary;

const session = (patch: Partial<E2eeSessionRow> = {}): E2eeSessionRow => ({
  peer_user_id: 'peer-1',
  peer_device_id: 'dev-1',
  session_pickle: 'S0',
  peer_identity_key: 'peer-ident',
  peer_signing_key: 'peer-sign',
  updated_at: '2026-01-01T00:00:00Z',
  ...patch,
});

/** Ligne d'outbox v3 : l'identité de session accompagne chaque enveloppe. */
const outbox = (clientId: string) => ({
  clientId,
  conversationId: 'conv-1',
  accountId: 'local-identity',
  peerUserId: 'peer-1',
  peerDeviceId: 'dev-1',
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function read(fixture: Fixture, sql: string, ...params: unknown[]) {
  return fixture.raw
    .prepare(sql)
    .all(...(params as never[]))
    .map((row) => ({ ...row }));
}

async function seeded(): Promise<Fixture> {
  const fixture = openDb();
  await migrateE2eeSchema(fixture.db);
  await fixture.handle.runAsync(
    `INSERT INTO e2ee_sessions
       (peer_user_id, peer_device_id, session_pickle, peer_identity_key, peer_signing_key, updated_at)
     VALUES ('peer-1', 'dev-1', 'S0', 'peer-ident', 'peer-sign', '2026-01-01T00:00:00Z')`,
  );
  return fixture;
}

const seal = (pickle: string, message: string) => ({
  session_pickle: pickle,
  session_id: 'sid',
  message_type: 'normal',
  message,
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

describe('persistSessionAndEnvelope — atomicité S1 + E', () => {
  it('un commit conserve simultanément S1 et E', async () => {
    const fixture = await seeded();
    const stored = await persistSessionAndEnvelope({
      db: fixture.db,
      session: session({ session_pickle: 'S1' }),
      envelope: { payload: 'E1', payloadType: 'normal' },
      outbox: outbox('c1'),
    });

    expect(stored).toEqual({ payload: 'E1', payloadType: 'normal' });
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    expect(read(fixture, 'SELECT * FROM e2ee_outbox')).toEqual([
      expect.objectContaining({
        client_id: 'c1',
        conversation_id: 'conv-1',
        envelope: 'E1',
        envelope_type: 'normal',
        state: 'pending',
        // S1 ne vit que dans e2ee_sessions : pas de seconde copie du pickle.
        session_pickle: '',
      }),
    ]);
  });

  it('un rollback ne conserve ni S1 ni E', async () => {
    const fixture = await seeded();
    fixture.raw.exec(`
      CREATE TRIGGER fail_outbox BEFORE INSERT ON e2ee_outbox
      BEGIN SELECT RAISE(ABORT, 'disque plein'); END;
    `);

    await expect(
      persistSessionAndEnvelope({
        db: fixture.db,
        session: session({ session_pickle: 'S1' }),
        envelope: { payload: 'E1', payloadType: 'normal' },
        outbox: outbox('c1'),
      }),
    ).rejects.toThrow(/disque plein/);

    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
    expect(read(fixture, 'SELECT * FROM e2ee_outbox')).toEqual([]);
  });

  it('une enveloppe déjà persistée n’est jamais écrasée, S1 non plus', async () => {
    const fixture = await seeded();
    await persistSessionAndEnvelope({
      db: fixture.db,
      session: session({ session_pickle: 'S1' }),
      envelope: { payload: 'E1', payloadType: 'normal' },
      outbox: outbox('c1'),
    });

    const stored = await persistSessionAndEnvelope({
      db: fixture.db,
      session: session({ session_pickle: 'S9' }),
      envelope: { payload: 'E9', payloadType: 'prekey' },
      outbox: outbox('c1'),
    });

    expect(stored).toEqual({ payload: 'E1', payloadType: 'normal' });
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    expect(read(fixture, 'SELECT envelope FROM e2ee_outbox')).toEqual([{ envelope: 'E1' }]);
  });

  it('écrit S1 sans journal quand la durabilité outbox n’est pas demandée', async () => {
    const fixture = await seeded();
    await persistSessionAndEnvelope({
      db: fixture.db,
      session: session({ session_pickle: 'S1' }),
      envelope: { payload: 'E1', payloadType: 'normal' },
    });
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    expect(read(fixture, 'SELECT * FROM e2ee_outbox')).toEqual([]);
  });

  it('efface les autres sessions du pair dans la même transaction (rotation)', async () => {
    const fixture = await seeded();
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_sessions
         (peer_user_id, peer_device_id, session_pickle, peer_identity_key, peer_signing_key, updated_at)
       VALUES ('peer-1', 'dev-2', 'S0-other', 'peer-ident-2', 'peer-sign-2', '2026-01-01T00:00:00Z')`,
    );

    await persistSessionAndEnvelope({
      db: fixture.db,
      session: session({ peer_device_id: 'dev-3', session_pickle: 'S1-new' }),
      envelope: { payload: 'E1', payloadType: 'prekey' },
      outbox: outbox('c1'),
      clearPeerSessions: true,
    });

    expect(
      read(fixture, 'SELECT peer_device_id FROM e2ee_sessions ORDER BY peer_device_id'),
    ).toEqual([{ peer_device_id: 'dev-3' }]);
  });
});

describe('encryptEnvelope — verrou et durabilité', () => {
  it('deux chiffrements concurrents sur la même session sont sérialisés', async () => {
    const fixture = await seeded();
    const order: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    cryptoMock.secureEncrypt.mockImplementation((async (pickle: string) => {
      order.push(pickle);
      // Le premier chiffrement reste ouvert : le second doit l'attendre.
      if (order.length === 1) await gate;
      return seal(pickle === 'S0' ? 'S1' : 'S2', `E-${pickle}`);
    }) as never);

    const first = encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'premier',
      allowKeyChange: false,
      clientId: 'c1',
    });
    await tick();
    const second = encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'second',
      allowKeyChange: false,
      clientId: 'c2',
    });
    await tick();

    // Le second n'a pas encore chiffré : il attend la session S1 du premier.
    expect(order).toEqual(['S0']);

    openGate();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(order).toEqual(['S0', 'S1']);
    expect(firstResult.payload).toBe('E-S0');
    expect(secondResult.payload).toBe('E-S1');
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S2' },
    ]);
  });

  it('deux pairs distincts ne se bloquent pas', async () => {
    const fixture = await seeded();
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_sessions
         (peer_user_id, peer_device_id, session_pickle, peer_identity_key, peer_signing_key, updated_at)
       VALUES ('peer-2', 'dev-2', 'S0-b', 'peer-ident-b', 'peer-sign-b', '2026-01-01T00:00:00Z')`,
    );
    apiMock.getE2eeKeyBundle.mockImplementation((async (_token: string, peerId: string) => ({
      deviceId: peerId === 'peer-1' ? 'dev-1' : 'dev-2',
      identityKey: peerId === 'peer-1' ? 'peer-ident' : 'peer-ident-b',
      // Même clé que la session stockée : pas de rotation, pas de prekey.
      signingKey: peerId === 'peer-1' ? 'peer-sign' : 'peer-sign-b',
      signedPrekey: null,
      signedPrekeySignature: null,
      oneTimeKey: null,
      fallback: null,
    })) as never);

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    cryptoMock.secureEncrypt.mockImplementation((async (pickle: string) => {
      if (pickle === 'S0') await gate; // seul le pair 1 est retenu
      return seal(`${pickle}+1`, `E-${pickle}`);
    }) as never);

    const blocked = encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'a',
      allowKeyChange: false,
      clientId: 'c1',
    });
    await tick();

    // Le pair 2 aboutit alors que le pair 1 est toujours bloqué.
    const other = await encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-2', 'peer-2'),
      currentUserId: 'me',
      plaintext: 'b',
      allowKeyChange: false,
      clientId: 'c2',
    });
    expect(other.payload).toBe('E-S0-b');

    openGate();
    await blocked;
  });

  it('une enveloppe existante n’est jamais recalculée', async () => {
    const fixture = await seeded();
    cryptoMock.secureEncrypt.mockResolvedValue(seal('S1', 'E1') as never);

    const first = await encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'bonjour',
      allowKeyChange: false,
      clientId: 'c1',
    });
    // Reprise avec un contenu différent : c'est l'enveloppe stockée qui part.
    const second = await encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'autre contenu',
      allowKeyChange: false,
      clientId: 'c1',
    });

    expect(first.payload).toBe('E1');
    expect(second.payload).toBe('E1');
    expect(cryptoMock.secureEncrypt).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
  });

  it('le chemin média (sans clientId) avance la session sans journaliser', async () => {
    const fixture = await seeded();
    cryptoMock.secureEncrypt.mockResolvedValue(seal('S1', 'E1') as never);

    const result = await encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'média',
      allowKeyChange: false,
    });

    expect(result.payload).toBe('E1');
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);
    // Pas de journal pour un chemin non migré : aucune reprise fantôme.
    expect(read(fixture, 'SELECT * FROM e2ee_outbox')).toEqual([]);
  });
});

describe('sendEncryptedText — aucun envoi avant commit, reprise identique', () => {
  const socket = (ack: (payload: { payload: string; clientId: string }) => Promise<unknown>) => {
    const emitWithAck = vi.fn(
      async (_event: string, payload: { payload: string; clientId: string }) => ack(payload),
    );
    socketMock.mockResolvedValue({ timeout: () => ({ emitWithAck }) } as never);
    return emitWithAck;
  };

  const send = (fixture: Fixture, clientId?: string) =>
    sendEncryptedText({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      currentUserName: 'Moi',
      text: 'bonjour',
      clientId,
    });

  it('un échec avant le commit ne provoque aucun envoi réseau', async () => {
    const fixture = await seeded();
    fixture.raw.exec(`
      CREATE TRIGGER fail_outbox BEFORE INSERT ON e2ee_outbox
      BEGIN SELECT RAISE(ABORT, 'disque plein'); END;
    `);
    cryptoMock.secureEncrypt.mockResolvedValue(seal('S1', 'E1') as never);
    const emitWithAck = socket(async () => ({ id: 'srv-1' }));

    await expect(send(fixture)).rejects.toThrow(/disque plein/);

    // Ni socket, ni message local : la transaction a échoué, rien n'est parti.
    expect(socketMock).not.toHaveBeenCalled();
    expect(emitWithAck).not.toHaveBeenCalled();
    expect(read(fixture, 'SELECT * FROM e2ee_messages')).toEqual([]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
  });

  it('une reprise après commit réutilise exactement la même enveloppe', async () => {
    const fixture = await seeded();
    cryptoMock.secureEncrypt.mockResolvedValue(seal('S1', 'E1') as never);

    // Premier envoi : l'enveloppe est commitée, puis le réseau échoue.
    const failing = socket(async () => {
      throw new Error('réseau coupé');
    });
    await expect(send(fixture, 'client-1')).rejects.toThrow('réseau coupé');

    expect(read(fixture, 'SELECT envelope, state FROM e2ee_outbox')).toEqual([
      { envelope: 'E1', state: 'pending' },
    ]);
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S1' },
    ]);

    // Reprise : mêmes identifiants, même enveloppe, aucune nouvelle avancée Olm.
    const resumed = socket(async () => ({ id: 'srv-9', createdAt: '2026-01-01T00:00:05Z' }));
    const result = await send(fixture, 'client-1');

    expect(result.clientId).toBe('client-1');
    const [failedEvent, failedPayload] = failing.mock.calls[0];
    const [resumedEvent, resumedPayload] = resumed.mock.calls[0];
    expect(resumedEvent).toBe(failedEvent);
    expect(resumedPayload.payload).toBe(failedPayload.payload);
    expect(resumedPayload.clientId).toBe('client-1');
    expect(failedPayload.payload).toBe('E1');
    expect(cryptoMock.secureEncrypt).toHaveBeenCalledTimes(1);
    expect(read(fixture, 'SELECT state FROM e2ee_outbox')).toEqual([{ state: 'sent' }]);
  });
});

describe('loadPersistedEnvelope — politique par état (v3)', () => {
  /** Ligne d'outbox déjà journalisée, dans l'état demandé. */
  async function seedOutbox(fixture: Fixture, state: string, clientId = 'c1') {
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_outbox
         (client_id, conversation_id, account_id, peer_user_id, peer_device_id,
          message_id, envelope, envelope_type, session_pickle, attachment_id,
          media_meta, quote_id, state, attempts, last_error, created_at, updated_at)
       VALUES (?, 'conv-1', 'local-identity', 'peer-1', 'dev-1', ?, 'E1', 'normal',
               '', NULL, NULL, NULL, ?, 0, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      clientId,
      state === 'sent' ? 'srv-1' : null,
      state,
      state === 'failed' ? 'réseau coupé' : null,
    );
  }

  const run = (fixture: Fixture, extra: Record<string, unknown> = {}) =>
    encryptEnvelope({
      token: 't',
      db: fixture.db,
      account,
      conversation: conversation('conv-1', 'peer-1'),
      currentUserId: 'me',
      plaintext: 'bonjour',
      allowKeyChange: false,
      clientId: 'c1',
      ...extra,
    });

  it('reprend une enveloppe pending sans rechiffrer', async () => {
    const fixture = await seeded();
    await seedOutbox(fixture, 'pending');
    const result = await run(fixture);
    expect(result.payload).toBe('E1');
    expect(cryptoMock.secureEncrypt).not.toHaveBeenCalled();
    // S1 n'a pas avancé : c'est l'enveloppe existante qui repart.
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
  });

  it('reprend une enveloppe sending (envoi interrompu)', async () => {
    const fixture = await seeded();
    await seedOutbox(fixture, 'sending');
    const result = await run(fixture);
    expect(result.payload).toBe('E1');
    expect(cryptoMock.secureEncrypt).not.toHaveBeenCalled();
  });

  it('refuse une enveloppe sent : aucun nouvel envoi, aucun chiffrement', async () => {
    const fixture = await seeded();
    await seedOutbox(fixture, 'sent');
    await expect(run(fixture)).rejects.toThrow('already_sent');
    expect(cryptoMock.secureEncrypt).not.toHaveBeenCalled();
    expect(read(fixture, 'SELECT session_pickle FROM e2ee_sessions')).toEqual([
      { session_pickle: 'S0' },
    ]);
  });

  it('ne reprend pas une enveloppe failed sans autorisation explicite', async () => {
    const fixture = await seeded();
    await seedOutbox(fixture, 'failed');
    await expect(run(fixture)).rejects.toThrow('outbox_failed');
    expect(cryptoMock.secureEncrypt).not.toHaveBeenCalled();
  });

  it('reprend une enveloppe failed quand la reprise est explicitement autorisée', async () => {
    const fixture = await seeded();
    await seedOutbox(fixture, 'failed');
    const result = await run(fixture, { resumeFailed: true });
    expect(result.payload).toBe('E1');
    expect(cryptoMock.secureEncrypt).not.toHaveBeenCalled();
  });

  it('aucune émission réseau pour une enveloppe déjà envoyée', async () => {
    const fixture = await seeded();
    await seedOutbox(fixture, 'sent');
    const emitWithAck = vi.fn();
    socketMock.mockResolvedValue({ timeout: () => ({ emitWithAck }) } as never);

    await expect(
      sendEncryptedText({
        token: 't',
        db: fixture.db,
        account,
        conversation: conversation('conv-1', 'peer-1'),
        currentUserId: 'me',
        currentUserName: 'Moi',
        text: 'bonjour',
        clientId: 'c1',
      }),
    ).rejects.toThrow('already_sent');

    expect(socketMock).not.toHaveBeenCalled();
    expect(emitWithAck).not.toHaveBeenCalled();
    expect(read(fixture, 'SELECT * FROM e2ee_messages')).toEqual([]);
    expect(read(fixture, 'SELECT state FROM e2ee_outbox')).toEqual([{ state: 'sent' }]);
  });

  it('sérialise deux transactions concurrentes au lieu de les imbriquer', async () => {
    // Sur appareil, `withExclusiveTransactionAsync` ouvrait une connexion sans
    // la clé SQLCipher (erreur 26). L'exclusivité vient maintenant de ce module :
    // deux écritures simultanées doivent passer l'une après l'autre.
    const fixture = await seeded();
    const journal: string[] = [];
    const db = {
      ...fixture.handle,
      execAsync: async (sql: string) => {
        if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
          journal.push(sql);
        }
        await fixture.handle.execAsync(sql);
      },
    };
    const write = (clientId: string) =>
      persistSessionAndEnvelope({
        db: db as never,
        session: session({ session_pickle: `S-${clientId}` }),
        envelope: { payload: `E-${clientId}`, payloadType: 'normal' },
        outbox: {
          clientId,
          conversationId: 'conv-1',
          accountId: 'local-identity',
          peerUserId: 'peer-1',
          peerDeviceId: 'dev-1',
        },
      });

    await Promise.all([write('c1'), write('c2')]);

    expect(journal).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT']);
    expect(
      read(fixture, 'SELECT client_id FROM e2ee_outbox ORDER BY client_id').map(
        (row) => row.client_id,
      ),
    ).toEqual(['c1', 'c2']);
  });

  it('libère la file des écritures après un échec de transaction', async () => {
    const fixture = await seeded();
    await fixture.handle.runAsync(
      `INSERT INTO e2ee_outbox (client_id, conversation_id, envelope, envelope_type, session_pickle, state, attempts, created_at, updated_at)
       VALUES ('boom', 'conv-1', 'E0', 'normal', '', 'sent', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    await expect(
      persistSessionAndEnvelope({
        db: fixture.db,
        session: session(),
        envelope: { payload: 'E1', payloadType: 'normal' },
        outbox: {
          clientId: 'boom',
          conversationId: 'conv-1',
          accountId: 'local-identity',
          peerUserId: 'peer-1',
          peerDeviceId: 'dev-1',
        },
      }),
    ).rejects.toThrow('outbox_sent');

    // La file doit être libre : la transaction suivante aboutit.
    await persistSessionAndEnvelope({
      db: fixture.db,
      session: session({ session_pickle: 'S-apres' }),
      envelope: { payload: 'E-apres', payloadType: 'normal' },
      outbox: {
        clientId: 'apres',
        conversationId: 'conv-1',
        accountId: 'local-identity',
        peerUserId: 'peer-1',
        peerDeviceId: 'dev-1',
      },
    });

    expect(read(fixture, "SELECT state FROM e2ee_outbox WHERE client_id = 'apres'")).toEqual([
      { state: 'pending' },
    ]);
    expect(
      read(fixture, "SELECT session_pickle FROM e2ee_sessions WHERE peer_device_id = 'dev-1'"),
    ).toEqual([{ session_pickle: 'S-apres' }]);
  });

  it('une nouvelle enveloppe porte l’identité de la session (v3)', async () => {
    const fixture = await seeded();
    cryptoMock.secureEncrypt.mockResolvedValue(seal('S1', 'E1') as never);
    await run(fixture);
    expect(
      read(fixture, 'SELECT account_id, peer_user_id, peer_device_id FROM e2ee_outbox'),
    ).toEqual([
      { account_id: 'local-identity', peer_user_id: 'peer-1', peer_device_id: 'dev-1' },
    ]);
  });
});
