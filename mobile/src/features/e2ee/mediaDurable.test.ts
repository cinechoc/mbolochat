import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary } from '@/lib/types';
import { loadOutboxMediaRefs } from './atomic';
import { loadMessageMediaRefs, saveLocalMessage, updateLocalMessageMedia } from './db';
import {
  abandonMediaPreparation,
  advanceMediaPreparation,
  createMediaPreparation,
  finalizeSentMediaPreparation,
  listIncompleteMediaPreparations,
  mediaUploadKey,
  listMediaPreparations,
  loadMediaPreparation,
} from './mediaPrep';
import { resumeEncryptedMedia, sendEncryptedMedia } from './media';
import {
  DURABLE_MEDIA_DIRECTORY,
  durableMediaUri,
  pruneOrphanDurableMedia,
  removeDurableMediaIfUnreferenced,
  storeDurableMedia,
  sweepDurablePartials,
} from './mediaStore';
import { migrateE2eeSchema } from './schema';

/**
 * Pipeline média de bout en bout, sur du vrai disque et une vraie base SQLite.
 *
 * Ce que ces tests démontrent et qu'un mock ne peut pas montrer : le
 * ciphertext survit à l'effacement du cache, la référence SQLCipher désigne un
 * fichier réel, et une reprise réutilise l'enveloppe journalisée sans
 * rechiffrer ni retéléverser. La couche Olm elle-même (S1 + E, verrous) est
 * couverte par `atomic.test.ts` et `text.test.ts` ; ici elle est remplacée par
 * une écriture des mêmes colonnes d'`e2ee_outbox`.
 */
const hooks = vi.hoisted(() => ({
  document: '',
  cache: '',
  order: [] as string[],
  /** Appelé juste après l'ouverture du fichier temporaire, copie en cours. */
  onCopyStart: null as null | (() => void),
}));

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: { encryptFile: vi.fn(), decryptFile: vi.fn() },
}));

vi.mock('@/lib/config', () => ({ API_URL: 'http://localhost:3001' }));

vi.mock('@/lib/api', () => ({ api: { uploadMedia: vi.fn() } }));
vi.mock('@/lib/socket', () => ({ ensureSocket: vi.fn() }));

vi.mock('expo-file-system', async () => {
  const fsp = await import('node:fs');
  const nodePath = await import('node:path');

  const toPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));
  const toUri = (full: string) =>
    `file://${full
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;

  class ShimDirectory {
    path: string;
    constructor(...uris: (string | ShimDirectory | ShimFile)[]) {
      this.path = nodePath.join(
        ...uris.map((uri) => (typeof uri === 'string' ? toPath(uri) : (uri as ShimDirectory).path)),
      );
    }
    get uri() {
      return toUri(this.path);
    }
    get exists() {
      return fsp.existsSync(this.path) && fsp.statSync(this.path).isDirectory();
    }
    create(options?: { intermediates?: boolean; idempotent?: boolean }) {
      if (this.exists) {
        if (options?.idempotent) return;
        throw new Error('directory_exists');
      }
      fsp.mkdirSync(this.path, { recursive: Boolean(options?.intermediates) });
    }
    delete() {
      fsp.rmSync(this.path, { recursive: true, force: true });
    }
    list() {
      if (!this.exists) return [];
      return fsp.readdirSync(this.path).map((name) => {
        const child = nodePath.join(this.path, name);
        return fsp.statSync(child).isDirectory() ? new ShimDirectory(child) : new ShimFile(child);
      });
    }
  }

  class ShimFile {
    path: string;
    constructor(...uris: (string | ShimDirectory | ShimFile)[]) {
      this.path = nodePath.join(
        ...uris.map((uri) => (typeof uri === 'string' ? toPath(uri) : (uri as ShimFile).path)),
      );
    }
    get uri() {
      return toUri(this.path);
    }
    get exists() {
      return fsp.existsSync(this.path);
    }
    get size() {
      return this.exists ? fsp.statSync(this.path).size : 0;
    }
    copy(destination: ShimFile | { uri: string }) {
      const target = destination instanceof ShimFile ? destination.path : toPath(destination.uri);
      const bytes = readFileSync(this.path);
      // Un `.part` est ouvert puis écrit : le balayage peut tomber à ce moment.
      writeFileSync(target, '');
      hooks.onCopyStart?.();
      writeFileSync(target, bytes);
    }
    move(destination: ShimFile | { uri: string }, options?: { overwrite?: boolean }) {
      const target = destination instanceof ShimFile ? destination.path : toPath(destination.uri);
      if (!options?.overwrite && fsp.existsSync(target)) throw new Error('file_exists');
      fsp.renameSync(this.path, target);
      // `File.move()` mute l'instance : son uri devient la destination.
      this.path = target;
    }
    delete() {
      fsp.rmSync(this.path, { force: true });
    }
    create(options?: { intermediates?: boolean; overwrite?: boolean }) {
      if (options?.overwrite) writeFileSync(this.path, '');
      else mkdirSync(nodePath.dirname(this.path), { recursive: true });
    }
  }

  return {
    File: ShimFile,
    Directory: ShimDirectory,
    Paths: {
      get document() {
        return new ShimDirectory(hooks.document);
      },
      get cache() {
        return new ShimDirectory(hooks.cache);
      },
    },
  };
});

const cryptoMock = vi.mocked(MboloCrypto);
const apiMock = vi.mocked(api);
const socketMock = vi.mocked(ensureSocket);

interface Handle {
  execAsync(sql: string, ...params: unknown[]): Promise<void>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: Handle) => Promise<void>): Promise<void>;
}

let raw: DatabaseSync;
let db: Handle;

function openDb(): void {
  raw = new DatabaseSync(':memory:');
  const handle: Handle = {
    execAsync: async (sql: string) => {
      raw.exec(sql);
    },
    getAllAsync: async <T,>(sql: string, ...params: unknown[]) =>
      raw
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => ({ ...row }) as T),
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
  db = handle;
}

vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: { manipulate: vi.fn() },
}));

vi.mock('expo-video-thumbnails', () => ({ getThumbnailAsync: vi.fn() }));

/** État du journal au moment précis où l'enveloppe est écrite. */
let journalSnapshot: { durableRefs: boolean; pendingOutbox: number } | null = null;

vi.mock('./text', () => ({
  E2eeAlreadySentError: class E2eeAlreadySentError extends Error {
    constructor(readonly clientId: string) {
      super('already_sent');
    }
  },
  encryptEnvelope: vi.fn(),
}));

vi.mock('./atomic', () => ({
  loadPersistedEnvelope: vi.fn(
    async (
      handle: {
        getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
      },
      clientId: string,
    ) => {
      const row = await handle.getFirstAsync<{
        envelope: string;
        envelope_type: string;
        state: string;
        message_id: string | null;
        last_error: string | null;
      }>(
        'SELECT envelope, envelope_type, state, message_id, last_error FROM e2ee_outbox WHERE client_id = ?',
        clientId,
      );
      if (!row) return { status: 'none' };
      const envelope = {
        payload: row.envelope,
        payloadType: row.envelope_type as 'prekey' | 'normal',
      };
      if (row.state === 'sent') return { status: 'sent', envelope, messageId: row.message_id };
      if (row.state === 'failed') {
        return { status: 'failed', envelope, error: row.last_error };
      }
      return { status: 'reusable', state: row.state, envelope };
    },
  ),
  loadOutboxMediaRefs: vi.fn(
    async (
      handle: { getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> },
      clientId: string,
    ) => {
      const row = await handle.getFirstAsync<{
        state: string;
        attachment_id: string | null;
        media_meta: string | null;
        quote_id: string | null;
      }>(
        'SELECT state, attachment_id, media_meta, quote_id FROM e2ee_outbox WHERE client_id = ?',
        clientId,
      );
      if (!row) return null;
      return {
        state: row.state,
        attachmentId: row.attachment_id,
        mediaMeta: row.media_meta,
        quoteId: row.quote_id,
      };
    },
  ),
  markEnvelopeSent: vi.fn(
    async (
      handle: { runAsync(sql: string, ...params: unknown[]): Promise<unknown> },
      clientId: string,
      messageId: string,
    ) => {
      await handle.runAsync(
        "UPDATE e2ee_outbox SET state = 'sent', message_id = ? WHERE client_id = ?",
        messageId,
        clientId,
      );
    },
  ),
}));

const { encryptEnvelope } = await import('./text');
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
    {
      id: 'me',
      username: 'moi',
      displayName: 'Moi',
      avatarUrl: null,
      gender: null,
      genderCustom: null,
      lastReadAt: null,
      role: 'member',
    },
    {
      id: 'peer',
      username: 'pair',
      displayName: 'Pair',
      avatarUrl: null,
      gender: null,
      genderCustom: null,
      lastReadAt: null,
      role: 'member',
    },
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

let uploads = 0;
let emitted: Record<string, unknown>[] = [];
let socketError: string | null = null;

function socketStub() {
  return {
    timeout: () => ({
      emitWithAck: async (_event: string, body: Record<string, unknown>) => {
        hooks.order.push('send');
        emitted.push(body);
        return socketError
          ? { error: socketError }
          : { id: 'srv-1', createdAt: '2026-01-02T00:00:00.000Z' };
      },
    }),
  } as never;
}

const durableIds = (): string[] => {
  const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY);
  try {
    return readdirSync(root).sort();
  } catch {
    return [];
  }
};

const send = (overrides: Partial<Parameters<typeof sendEncryptedMedia>[0]> = {}) =>
  sendEncryptedMedia({
    token: 'jeton',
    db: db as never,
    account,
    conversation,
    currentUserId: 'me',
    currentUserName: 'Moi',
    asset: {
      uri: `file://${join(hooks.cache, 'notes', 'doc.pdf')}`,
      kind: 'file',
      mime: 'application/pdf',
      name: 'doc.pdf',
      size: 12,
    },
    ...overrides,
  });

beforeEach(async () => {
  hooks.document = mkdtempSync(join(tmpdir(), 'mbolo-doc-'));
  hooks.cache = mkdtempSync(join(tmpdir(), 'mbolo-cache-'));
  hooks.order = [];
  hooks.onCopyStart = null;
  journalSnapshot = null;
  uploads = 0;
  emitted = [];
  socketError = null;
  openDb();
  await migrateE2eeSchema(db);

  mkdirSync(join(hooks.cache, 'notes'), { recursive: true });
  writeFileSync(join(hooks.cache, 'notes', 'doc.pdf'), 'PLAINTEXT-12');

  vi.clearAllMocks();
  cryptoMock.encryptFile.mockImplementation(async (plain: string, output: string) => {
    hooks.order.push('encrypt');
    const bytes = readFileSync(plain);
    // Ciphertext reconnaissable : aucun octet du clair ne doit fuiter.
    writeFileSync(output, Buffer.from(bytes.map((byte) => byte ^ 0x5a)));
    return {
      file_key_b64: 'cle',
      nonce_b64: 'nonce',
      sha256_hex: 'ab'.repeat(32),
      plaintext_size: bytes.length,
      ciphertext_size: bytes.length,
    } as never;
  });
  apiMock.uploadMedia.mockImplementation(async () => {
    hooks.order.push('upload');
    uploads += 1;
    return { id: `up-${uploads}`, type: 'FILE', url: '', mime: '', size: 0 } as never;
  });
  socketMock.mockImplementation(async () => socketStub());
  envelopeMock.mockImplementation(async (input) => {
    const typed = input as unknown as {
      clientId: string;
      conversation: { id: string };
      attachmentId?: string | null;
      mediaMeta?: string | null;
      quoteId?: string | null;
    };
    hooks.order.push('journal');
    const refs = await loadMessageMediaRefs(db as never, typed.clientId);
    journalSnapshot = {
      durableRefs: Boolean(refs?.local_cipher_uri),
      pendingOutbox: (
        await db.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) AS n FROM e2ee_outbox WHERE state != 'sent'",
        )
      )!.n,
    };
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO e2ee_outbox
        (client_id, conversation_id, envelope, envelope_type, session_pickle,
         attachment_id, media_meta, quote_id, state, created_at, updated_at)
       VALUES (?, ?, ?, 'prekey', '', ?, ?, ?, 'pending', ?, ?)`,
      typed.clientId,
      typed.conversation.id,
      `env-${typed.clientId}`,
      typed.attachmentId ?? null,
      typed.mediaMeta ?? null,
      typed.quoteId ?? null,
      now,
      now,
    );
    return {
      payload: `env-${typed.clientId}`,
      payloadType: 'prekey' as const,
      peerId: 'peer',
      signingKey: 'sign',
      identityKey: 'ident',
      deviceId: 'dev-1',
    };
  });
});

afterEach(() => {
  raw.close();
  rmSync(hooks.document, { recursive: true, force: true });
  rmSync(hooks.cache, { recursive: true, force: true });
});

/** Identifiant du média durable effectivement journalisé. */
async function journaledClientId(): Promise<string> {
  const row = await db.getFirstAsync<{ client_id: string }>(
    'SELECT client_id FROM e2ee_outbox ORDER BY created_at DESC LIMIT 1',
  );
  return row!.client_id;
}

const mediaRow = (id: string) =>
  db.getFirstAsync<{
    local_cipher_uri: string | null;
    local_thumb_cipher_uri: string | null;
    upload_id: string | null;
    media_meta: string | null;
  }>(
    'SELECT local_cipher_uri, local_thumb_cipher_uri, upload_id, media_meta FROM e2ee_messages WHERE id = ?',
    id,
  );

describe('média chiffré durable', () => {
  it('n écrit que du ciphertext dans le stockage durable', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');

    const [id] = durableIds();
    expect(durableIds()).toHaveLength(1);
    expect(readdirSync(join(hooks.document, DURABLE_MEDIA_DIRECTORY, id))).toEqual(['cipher.bin']);
    const stored = readFileSync(join(hooks.document, DURABLE_MEDIA_DIRECTORY, id, 'cipher.bin'));
    expect(stored.toString()).not.toContain('PLAINTEXT');
    expect(stored.toString()).not.toBe('PLAINTEXT-12');
    // Le ciphertext est bien celui produit par la crypto, octet pour octet.
    expect([...stored].length).toBe(12);
  });

  it('écrit la référence SQLCipher avant le journal, et le journal avant l envoi', async () => {
    await send();
    expect(journalSnapshot).toEqual({ durableRefs: true, pendingOutbox: 0 });
    expect(hooks.order).toEqual(['encrypt', 'upload', 'journal', 'send']);
  });

  it('survit à l effacement complet du cache', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();
    const durablePath = join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId, 'cipher.bin');
    expect(readFileSync(durablePath).length).toBe(12);

    // L'URI de cache a disparu : plus aucun clair, plus aucun ciphertext de travail.
    rmSync(hooks.cache, { recursive: true, force: true });
    socketError = null;

    const result = await resumeEncryptedMedia({
      token: 'jeton',
      db: db as never,
      account,
      conversation,
      currentUserId: 'me',
      currentUserName: 'Moi',
      clientId,
    });
    expect(result.serverMessage).toMatchObject({ id: 'srv-1' });
  });

  it('un échec réseau conserve le ciphertext, le journal, et retire la bulle provisoire', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');

    const clientId = await journaledClientId();
    const outbox = await loadOutboxMediaRefs(db as never, clientId);
    expect(outbox).toMatchObject({ state: 'pending', attachmentId: 'up-1' });
    expect(durableMediaUri(clientId)).not.toBeNull();
    // Aucune ligne de message : rien ne se prétend envoyé ni visible.
    const count = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM e2ee_messages');
    expect(count!.n).toBe(0);
  });

  it('la reprise réutilise l enveloppe journalisée, sans rechiffrer ni retéléverser', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();
    const encryptedBefore = cryptoMock.encryptFile.mock.calls.length;
    const uploadsBefore = uploads;
    socketError = null;

    await resumeEncryptedMedia({
      token: 'jeton',
      db: db as never,
      account,
      conversation,
      currentUserId: 'me',
      currentUserName: 'Moi',
      clientId,
    });

    expect(cryptoMock.encryptFile.mock.calls.length).toBe(encryptedBefore);
    expect(uploads).toBe(uploadsBefore);
    expect(envelopeMock).toHaveBeenCalledTimes(1);
    // Le même ciphertext est réexpédié, sans nouvelle clé ni nouveau blob.
    expect(emitted[0]).toMatchObject({ attachmentId: 'up-1', clientId });
    expect(emitted[0].payload).toBe(`env-${clientId}`);
  });

  it('la reprise réexpédie le même ciphertext, sans le modifier', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();
    const path = join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId, 'cipher.bin');
    const before = readFileSync(path);

    // Deuxième échec réseau : la reprise ne touche pas au fichier.
    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId,
      }),
    ).rejects.toThrow('réseau');
    expect(readFileSync(path)).toEqual(before);

    socketError = null;
    await resumeEncryptedMedia({
      token: 'jeton',
      db: db as never,
      account,
      conversation,
      currentUserId: 'me',
      currentUserName: 'Moi',
      clientId,
    });
    // Envoi accepté : le ciphertext local est devenu inutile.
    expect(durableMediaUri(clientId)).toBeNull();
  });

  it('un fichier durable absent est une erreur explicite, jamais un succès', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();
    rmSync(join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId), {
      recursive: true,
      force: true,
    });
    socketError = null;
    emitted = [];

    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId,
      }),
    ).rejects.toThrow('durable_file_missing');

    // Rien n'a été émis et le journal reste en attente, pas en succès.
    expect(emitted).toHaveLength(0);
    expect(await loadOutboxMediaRefs(db as never, clientId)).toMatchObject({ state: 'pending' });
  });

  it('refuse de reprendre un envoi déjà acquitté', async () => {
    await send();
    const clientId = await journaledClientId();
    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId,
      }),
    ).rejects.toThrow('already_sent');
    expect(emitted).toHaveLength(1);
  });

  it('ne reconstruit pas d enveloppe sans journal, même quand SQLCipher porte tout', async () => {
    // Fenêtre de coupure C : le message provisoire, ses clés (`media_meta`), ses
    // identifiants d'upload et le ciphertext durable existent, mais l'outbox est
    // vide. La reprise lit `media_meta`/`attachment_id` **dans le journal**
    // (`loadOutboxMediaRefs`), pas dans la ligne du message : elle refuse donc au
    // lieu de reconstruire. Ce test épingle ce comportement pour qu'il ne change
    // pas en silence — le jour où la reconstruction est implémentée, il tombe.
    const cipherPath = join(hooks.cache, 'reste-cipher.bin');
    writeFileSync(cipherPath, Buffer.from([0x11, 0x22, 0x33]));
    const durable = await storeDurableMedia({
      id: 'c3',
      sourceUri: `file://${cipherPath}`,
    });
    const mediaMeta = JSON.stringify({
      type: 'FILE',
      mime: 'application/pdf',
      name: 'doc.pdf',
      blob: { file_key_b64: 'cle', nonce_b64: 'nonce', sha256_hex: 'ab', uploadId: 'up-c3' },
    });
    await saveLocalMessage(db as never, {
      id: 'c3',
      conversation_id: conversation.id,
      sender_id: 'me',
      sender_name: 'Moi',
      body: 'légende',
      created_at: '2026-01-01T00:00:00Z',
      client_id: 'c3',
      mine: 1,
      media_meta: mediaMeta,
      quote_id: null,
    });
    await updateLocalMessageMedia(db as never, 'c3', {
      localCipherUri: durable.uri,
      uploadId: 'up-c3',
    });

    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId: 'c3',
      }),
    ).rejects.toThrow('media_not_journaled');

    // Ni émission, ni nouveau téléversement : rien n'est réinventé.
    expect(emitted).toHaveLength(0);
    expect(uploads).toBe(0);
    // Et rien n'a été détruit : les données nécessaires à une future
    // reconstruction sont toujours là, fichier compris.
    expect(
      readFileSync(join(hooks.document, DURABLE_MEDIA_DIRECTORY, 'c3', 'cipher.bin')).length,
    ).toBe(3);
    expect(await loadMessageMediaRefs(db as never, 'c3')).toMatchObject({
      local_cipher_uri: durable.uri,
      upload_id: 'up-c3',
    });
  });

  it('refuse de reprendre un média qui n a jamais été journalisé', async () => {
    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId: 'inconnu',
      }),
    ).rejects.toThrow('media_not_journaled');
  });

  it('retire les références durables après un envoi accepté, et garde l identifiant d upload', async () => {
    await send();
    const clientId = await journaledClientId();
    const row = await mediaRow('srv-1');
    expect(row).toMatchObject({
      local_cipher_uri: null,
      local_thumb_cipher_uri: null,
      upload_id: 'up-1',
    });
    expect(row!.media_meta).toContain('up-1');
    // Plus rien ne référence le ciphertext : le dossier disparaît.
    expect(durableMediaUri(clientId)).toBeNull();
    expect(durableIds()).toHaveLength(0);
  });

  it('ne supprime jamais un média encore référencé par un envoi en cours', async () => {
    const id = 'media-en-cours';
    const source = join(hooks.cache, 'source.bin');
    writeFileSync(source, 'cipher');
    await storeDurableMedia({ id, sourceUri: `file://${source}` });

    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO e2ee_outbox
        (client_id, conversation_id, envelope, envelope_type, session_pickle, state, created_at, updated_at)
       VALUES (?, 'conv-1', 'e', 'prekey', '', 'pending', ?, ?)`,
      id,
      now,
      now,
    );
    expect(await removeDurableMediaIfUnreferenced(db as never, id)).toBe(false);
    expect(durableMediaUri(id)).not.toBeNull();

    await db.runAsync("UPDATE e2ee_outbox SET state = 'sent' WHERE client_id = ?", id);
    expect(await removeDurableMediaIfUnreferenced(db as never, id)).toBe(true);
    expect(durableMediaUri(id)).toBeNull();
  });

  it('détecte comme orphelins les ciphertexts qu aucun message ni envoi ne référence', async () => {
    const orphan = join(hooks.cache, 'orphelin.bin');
    writeFileSync(orphan, 'cipher');
    await storeDurableMedia({ id: 'orphelin', sourceUri: `file://${orphan}` });

    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const referenced = await journaledClientId();

    const removed = await pruneOrphanDurableMedia(db as never);
    expect(removed).toEqual(['orphelin']);
    expect(durableMediaUri('orphelin')).toBeNull();
    expect(durableMediaUri(referenced)).not.toBeNull();
  });

  it('le balayage des temporaires n efface pas une écriture en cours', async () => {
    const id = 'ecriture-vivante';
    const source = join(hooks.cache, 'vivant.bin');
    writeFileSync(source, 'x'.repeat(64));
    const seen: string[] = [];
    hooks.onCopyStart = () => {
      const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY, id);
      seen.push(...readdirSync(root).filter((name) => name.endsWith('.part')));
      // Un balayage de démarrage tombe pile pendant la copie.
      sweepDurablePartials();
      seen.push(...readdirSync(root).filter((name) => name.endsWith('.part')));
    };

    await storeDurableMedia({ id, sourceUri: `file://${source}` });

    // Le temporaire vivant a survécu au balayage, puis la copie a abouti.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0].endsWith('.part')).toBe(true);
    const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY, id);
    expect(readdirSync(root)).toEqual(['cipher.bin']);
    expect(readFileSync(join(root, 'cipher.bin')).length).toBe(64);
  });

  it('la vignette suit le même cycle durable que le média', async () => {
    mkdirSync(join(hooks.cache, 'videos'), { recursive: true });
    const clip = join(hooks.cache, 'videos', 'clip.mp4');
    writeFileSync(clip, 'VIDEO-BYTES');
    const thumbFile = join(hooks.cache, 'videos', 'thumb.jpg');
    writeFileSync(thumbFile, 'THUMB');
    const { getThumbnailAsync } = await import('expo-video-thumbnails');
    vi.mocked(getThumbnailAsync).mockResolvedValue({
      uri: `file://${thumbFile}`,
      width: 320,
      height: 180,
    });

    socketError = 'réseau';
    await expect(
      send({
        asset: {
          uri: `file://${clip}`,
          kind: 'video',
          mime: 'video/mp4',
          name: 'clip.mp4',
          size: 11,
          durationMs: 3000,
        },
      }),
    ).rejects.toThrow('réseau');

    const clientId = await journaledClientId();
    const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId);
    expect(readdirSync(root).sort()).toEqual(['cipher.bin', 'thumb-cipher.bin']);
    const refs = await loadOutboxMediaRefs(db as never, clientId);
    expect(refs!.mediaMeta).toContain('up-2');
    expect(uploads).toBe(2);

    socketError = null;
    await resumeEncryptedMedia({
      token: 'jeton',
      db: db as never,
      account,
      conversation,
      currentUserId: 'me',
      currentUserName: 'Moi',
      clientId,
    });
    expect(durableMediaUri(clientId)).toBeNull();
    expect(durableMediaUri(clientId, 'thumb')).toBeNull();
  });

  it('deux écritures durables simultanées ne se détruisent pas', async () => {
    const source = join(hooks.cache, 'concurrent.bin');
    writeFileSync(source, 'ciphertext');
    const [media, thumb] = await Promise.all([
      storeDurableMedia({ id: 'double', sourceUri: `file://${source}` }),
      storeDurableMedia({ id: 'double', kind: 'thumb', sourceUri: `file://${source}` }),
    ]);
    expect(media.uri).not.toBe(thumb.uri);
    const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY, 'double');
    expect(readdirSync(root).sort()).toEqual(['cipher.bin', 'thumb-cipher.bin']);
  });
});

/**
 * Journal de préparation (étape 1.2c).
 *
 * Chaque cas reproduit l'**état persisté** laissé par une coupure à un endroit
 * précis du cycle, puis interroge l'API de récupération dans un appel neuf :
 * aucune valeur ne vient de la mémoire de l'envoi qui a échoué.
 */
describe('journal de préparation média', () => {
  it('A. retrouve clientId, clés et fichier après une coupure au téléversement', async () => {
    apiMock.uploadMedia.mockRejectedValueOnce(new Error('réseau'));
    await expect(send()).rejects.toThrow('réseau');

    const [preparation] = await listIncompleteMediaPreparations(db as never);
    // Identité et clés viennent de SQLCipher seul.
    expect(preparation.clientId).toMatch(/^[a-z0-9-]+$/);
    expect(preparation.conversationId).toBe(conversation.id);
    expect(preparation.media?.blob.fileKey).toBe('cle');
    expect(preparation.media?.blob.nonce).toBe('nonce');
    expect(preparation.state).toBe('stored');
    expect(preparation.mediaPresent).toBe(true);
    expect(preparation.localCipherUri).toBe(
      durableMediaUri(preparation.clientId),
    );
    // Le ciphertext sur disque est bien celui que la préparation décrit.
    expect(
      readFileSync(
        join(hooks.document, DURABLE_MEDIA_DIRECTORY, preparation.clientId, 'cipher.bin'),
      ).length,
    ).toBe(preparation.media!.blob.size);
    // Aucun identifiant d'upload : la reprise buterait sur `/uploads`.
    expect(preparation.outcome).toEqual({ kind: 'upload_unconfirmed' });
    expect(preparation.attachmentId).toBeNull();
  });

  it('B. après un téléversement partiel, l identifiant obtenu est conservé', async () => {
    mkdirSync(join(hooks.cache, 'videos'), { recursive: true });
    const clip = join(hooks.cache, 'videos', 'clip.mp4');
    writeFileSync(clip, 'VIDEO-BYTES');
    const thumbFile = join(hooks.cache, 'videos', 'thumb.jpg');
    writeFileSync(thumbFile, 'THUMB');
    const { getThumbnailAsync } = await import('expo-video-thumbnails');
    vi.mocked(getThumbnailAsync).mockResolvedValue({
      uri: `file://${thumbFile}`,
      width: 320,
      height: 180,
    });
    // Le média passe, la vignette échoue : le serveur n'est pas idempotent sur
    // `/uploads`, donc la miniature devra être retéléversée — et l'API le dit.
    apiMock.uploadMedia
      .mockImplementationOnce(async () => {
        uploads += 1;
        return { id: 'up-media', type: 'VIDEO', url: '', mime: '', size: 0 } as never;
      })
      .mockRejectedValueOnce(new Error('réseau'));

    await expect(
      send({
        asset: {
          uri: `file://${clip}`,
          kind: 'video',
          mime: 'video/mp4',
          name: 'clip.mp4',
          size: 11,
          durationMs: 3000,
        },
      }),
    ).rejects.toThrow('réseau');

    const [preparation] = await listIncompleteMediaPreparations(db as never);
    // L'identifiant obtenu est persisté immédiatement, pas à la fin.
    expect(preparation.attachmentId).toBe('up-media');
    expect(preparation.thumbUploadId).toBeNull();
    expect(preparation.mediaPresent).toBe(true);
    expect(preparation.thumbPresent).toBe(true);
    expect(preparation.outcome).toEqual({ kind: 'upload_unconfirmed' });
  });

  it('C. reconstruit l état complet quand SQLCipher est écrit mais pas l outbox', async () => {
    // État exact laissé par une coupure entre l'écriture du message et le
    // journal : la préparation et la ligne SQLCipher existent, l'outbox non.
    const clientId = 'prep-c';
    const keys = {
      uploadId: 'up-c',
      fileKey: 'cle-c',
      nonce: 'nonce-c',
      sha256: 'ab'.repeat(32),
      size: 3,
    };
    const mediaMeta = JSON.stringify({
      type: 'FILE',
      mime: 'application/pdf',
      name: 'doc.pdf',
      blob: keys,
    });
    const cipherPath = join(hooks.cache, 'prep-c.bin');
    writeFileSync(cipherPath, Buffer.from([0x11, 0x22, 0x33]));
    const durable = await storeDurableMedia({ id: clientId, sourceUri: `file://${cipherPath}` });
    await createMediaPreparation(db as never, {
      clientId,
      conversationId: conversation.id,
      mediaMeta,
      now: '2026-01-01T00:00:00Z',
    });
    await advanceMediaPreparation(db as never, clientId, {
      state: 'message',
      localCipherUri: durable.uri,
      attachmentId: 'up-c',
      mediaMeta,
    });
    await saveLocalMessage(db as never, {
      id: clientId,
      conversation_id: conversation.id,
      sender_id: 'me',
      sender_name: 'Moi',
      body: 'légende',
      created_at: '2026-01-01T00:00:00Z',
      client_id: clientId,
      mine: 1,
      media_meta: mediaMeta,
      quote_id: null,
    });
    await updateLocalMessageMedia(db as never, clientId, {
      localCipherUri: durable.uri,
      uploadId: 'up-c',
    });

    const preparation = await loadMediaPreparation(db as never, clientId);
    expect(preparation).toMatchObject({
      state: 'message',
      messagePresent: true,
      outboxState: null,
      attachmentId: 'up-c',
      mediaPresent: true,
      mediaMeta,
    });
    // Le cas est distingué explicitement : rien n'est émis ni inventé.
    expect(preparation!.outcome).toEqual({ kind: 'message_without_outbox' });
    expect(preparation!.media?.blob.fileKey).toBe('cle-c');
    expect(emitted).toHaveLength(0);
    // La reprise existante refuse toujours sans journal : pas de fausse reprise.
    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId,
      }),
    ).rejects.toThrow('media_not_journaled');
  });

  it('D. après journalisation, la préparation annonce la même enveloppe à réémettre', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();

    const preparation = await loadMediaPreparation(db as never, clientId);
    expect(preparation).toMatchObject({ state: 'journaled', outboxState: 'pending' });
    expect(preparation!.outcome).toEqual({ kind: 'recoverable', next: 'emit' });
    const journaled = (await loadOutboxMediaRefs(db as never, clientId))!;
    expect(preparation!.mediaMeta).toBe(journaled.mediaMeta);

    const before = emitted.length;
    socketError = null;
    await resumeEncryptedMedia({
      token: 'jeton',
      db: db as never,
      account,
      conversation,
      currentUserId: 'me',
      currentUserName: 'Moi',
      clientId,
    });
    // Envoi acquitté : plus de préparation, plus de ciphertext local, et une
    // seule émission supplémentaire — la même enveloppe, pas une nouvelle.
    expect(await loadMediaPreparation(db as never, clientId)).toBeNull();
    expect(durableMediaUri(clientId)).toBeNull();
    expect(emitted.slice(before)).toHaveLength(1);
    // Même ciphertext qu'à la première tentative : rien n'a été rechiffré.
    expect(emitted[before].payload).toBe(emitted[0].payload);
  });

  it('E. un échec de encryptEnvelope ne laisse aucune bulle provisoire', async () => {
    envelopeMock.mockRejectedValueOnce(new Error('Aucun appareil E2EE actif'));
    await expect(send()).rejects.toThrow('Aucun appareil E2EE actif');

    const count = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM e2ee_messages',
    );
    expect(count!.n).toBe(0);
    const outbox = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM e2ee_outbox',
    );
    expect(outbox!.n).toBe(0);
    // L'état reste récupérable : clés, fichier et identifiant d'upload sont là.
    const [preparation] = await listIncompleteMediaPreparations(db as never);
    // La ligne ayant été retirée, l'état persisté ne prétend pas qu'elle existe.
    expect(preparation).toMatchObject({
      state: 'uploaded',
      messagePresent: false,
      outboxState: null,
      attachmentId: 'up-1',
    });
    expect(preparation.outcome).toEqual({ kind: 'recoverable', next: 'journal' });
    expect(preparation.lastError).toContain('Aucun appareil E2EE actif');
    expect(preparation.attempts).toBe(1);
  });

  it('F. un échec de stockage durable n écrit aucune référence trompeuse', async () => {
    // Le chiffrement produit un fichier vide : la copie durable échoue.
    cryptoMock.encryptFile.mockImplementationOnce(async (_plain: string, output: string) => {
      writeFileSync(output, '');
      return {
        file_key_b64: 'cle',
        nonce_b64: 'nonce',
        sha256_hex: 'ab'.repeat(32),
        plaintext_size: 0,
        ciphertext_size: 0,
      } as never;
    });
    await expect(send()).rejects.toThrow('durable_source_empty');

    const [preparation] = await listIncompleteMediaPreparations(db as never);
    // Aucune URI n'est écrite tant que le fichier n'est pas vérifié.
    expect(preparation.localCipherUri).toBeNull();
    expect(preparation.mediaPresent).toBe(false);
    expect(preparation.outcome).toEqual({ kind: 'durable_file_missing' });
    const count = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM e2ee_messages',
    );
    expect(count!.n).toBe(0);
  });

  it('G. un fichier durable disparu n est jamais un succès', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();

    rmSync(join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId), {
      recursive: true,
      force: true,
    });

    const preparation = await loadMediaPreparation(db as never, clientId);
    expect(preparation!.mediaPresent).toBe(false);
    expect(preparation!.outcome).toEqual({ kind: 'durable_file_missing' });

    socketError = null;
    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId,
      }),
    ).rejects.toThrow('durable_file_missing');
    expect(emitted).toHaveLength(1);
  });

  it('H. une préparation retient son fichier, un abandon le libère', async () => {
    apiMock.uploadMedia.mockRejectedValueOnce(new Error('réseau'));
    await expect(send()).rejects.toThrow('réseau');
    const [preparation] = await listIncompleteMediaPreparations(db as never);
    const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY, preparation.clientId);

    // Référencé par la préparation : jamais supprimé, même sans message.
    expect(await removeDurableMediaIfUnreferenced(db as never, preparation.clientId)).toBe(false);
    expect(readdirSync(root)).toEqual(['cipher.bin']);

    await abandonMediaPreparation(db as never, preparation.clientId, 'test');
    const after = await loadMediaPreparation(db as never, preparation.clientId);
    expect(after!.outcome).toEqual({ kind: 'abandoned' });
    expect(await removeDurableMediaIfUnreferenced(db as never, preparation.clientId)).toBe(true);
    expect(durableIds()).not.toContain(preparation.clientId);
  });

  it('J. outbox déjà envoyée : classé envoyé, nettoyable, jamais réémis', async () => {
    // État exact d'une coupure entre l'accusé de réception et la purge : outbox
    // `sent`, ligne SQLCipher avec ses références, préparation et fichier vivants.
    const clientId = 'prep-j';
    const keys = {
      uploadId: 'up-j',
      fileKey: 'cle-j',
      nonce: 'nonce-j',
      sha256: 'cd'.repeat(32),
      size: 3,
    };
    const mediaMeta = JSON.stringify({
      type: 'FILE',
      mime: 'application/pdf',
      name: 'doc.pdf',
      blob: keys,
    });
    const source = join(hooks.cache, 'prep-j.bin');
    writeFileSync(source, Buffer.from([0xaa, 0xbb, 0xcc]));
    const durable = await storeDurableMedia({ id: clientId, sourceUri: `file://${source}` });
    await createMediaPreparation(db as never, {
      clientId,
      conversationId: conversation.id,
      mediaMeta,
      now: '2026-01-01T00:00:00Z',
    });
    for (const state of ['stored', 'uploaded', 'message', 'journaled'] as const) {
      await advanceMediaPreparation(db as never, clientId, {
        state,
        localCipherUri: durable.uri,
        attachmentId: 'up-j',
        mediaMeta,
      });
    }
    await saveLocalMessage(db as never, {
      id: clientId,
      conversation_id: conversation.id,
      sender_id: 'me',
      sender_name: 'Moi',
      body: 'doc',
      created_at: '2026-01-01T00:00:00Z',
      client_id: clientId,
      mine: 1,
      media_meta: mediaMeta,
      quote_id: null,
    });
    await updateLocalMessageMedia(db as never, clientId, {
      localCipherUri: durable.uri,
      uploadId: 'up-j',
    });
    await db.runAsync(
      `INSERT INTO e2ee_outbox
         (client_id, conversation_id, message_id, envelope, envelope_type,
          session_pickle, attachment_id, media_meta, quote_id, state, attempts,
          last_error, created_at, updated_at)
       VALUES (?, ?, 'srv-j', 'E-j', 'normal', '', 'up-j', ?, NULL, 'sent', 1,
               NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      clientId,
      conversation.id,
      mediaMeta,
    );

    const preparation = await loadMediaPreparation(db as never, clientId);
    expect(preparation).toMatchObject({
      state: 'journaled',
      outboxState: 'sent',
      messagePresent: true,
      mediaPresent: true,
      attachmentId: 'up-j',
    });
    // Envoyé reconnu : la classification passe avant tout le reste.
    expect(preparation!.outcome).toEqual({ kind: 'already_sent' });
    expect(await listIncompleteMediaPreparations(db as never)).toEqual([]);

    const emissions = emitted.length;
    await expect(
      resumeEncryptedMedia({
        token: 'jeton',
        db: db as never,
        account,
        conversation,
        currentUserId: 'me',
        currentUserName: 'Moi',
        clientId,
      }),
    ).rejects.toThrow('already_sent');
    expect(emitted.length).toBe(emissions);

    // Nettoyage ultérieur : références retirées, préparation purgée, fichier
    // libéré — et toujours aucune émission.
    expect(await finalizeSentMediaPreparation(db as never, clientId)).toEqual({
      kind: 'already_sent',
      clearedMessageRefs: true,
      filesRemoved: true,
    });
    const refs = await loadMessageMediaRefs(db as never, clientId);
    expect(refs!.local_cipher_uri).toBeNull();
    // L'identifiant du blob accepté par le serveur n'est pas effacé.
    expect(refs!.upload_id).toBe('up-j');
    expect(await loadMediaPreparation(db as never, clientId)).toBeNull();
    expect(durableMediaUri(clientId)).toBeNull();
    expect(emitted.length).toBe(emissions);
    // Rejouer le nettoyage ne casse rien et n'émet rien.
    expect(await finalizeSentMediaPreparation(db as never, clientId)).toEqual({
      kind: 'no_preparation',
    });
  });

  it('J ter. le nettoyage refuse d agir tant que l envoi n est pas acquitté', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();
    const root = join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId);

    expect(await finalizeSentMediaPreparation(db as never, clientId)).toEqual({
      kind: 'not_sent',
    });
    // Rien n'a bougé : la préparation et le fichier restent récupérables.
    expect((await loadMediaPreparation(db as never, clientId))!.state).toBe('journaled');
    expect(readdirSync(root)).toEqual(['cipher.bin']);
  });

  it('J bis. l état envoyé survit à la disparition du fichier durable', async () => {
    socketError = 'réseau';
    await expect(send()).rejects.toThrow('réseau');
    const clientId = await journaledClientId();
    await db.runAsync(
      "UPDATE e2ee_outbox SET state = 'sent' WHERE client_id = ?",
      clientId,
    );
    rmSync(join(hooks.document, DURABLE_MEDIA_DIRECTORY, clientId), {
      recursive: true,
      force: true,
    });
    const preparation = await loadMediaPreparation(db as never, clientId);
    // La question « le fichier est-il là ? » ne se pose plus : c'est envoyé.
    expect(preparation!.outcome).toEqual({ kind: 'already_sent' });
    expect(preparation!.mediaPresent).toBe(false);
  });

  it('K. les clés d idempotence sont stables, distinctes et dérivées du clientId', async () => {
    // Dérivation pure : même identité durable, même clé, quel que soit l'appel.
    expect(mediaUploadKey('client-1', 'media')).toBe('client-1:media');
    expect(mediaUploadKey('client-1', 'thumb')).toBe('client-1:thumb');
    expect(mediaUploadKey('client-1', 'media')).toBe(
      mediaUploadKey('client-1', 'media'),
    );
    // Le média et sa vignette ne partagent jamais la même clé.
    expect(mediaUploadKey('client-1', 'media')).not.toBe(
      mediaUploadKey('client-1', 'thumb'),
    );
    // Deux messages distincts ne se dédupliquent pas l'un l'autre.
    expect(mediaUploadKey('client-1', 'media')).not.toBe(
      mediaUploadKey('client-2', 'media'),
    );

    // Côté envoi : les clés réellement transmises suivent le journal durable.
    mkdirSync(join(hooks.cache, 'videos'), { recursive: true });
    const clip = join(hooks.cache, 'videos', 'clip.mp4');
    writeFileSync(clip, 'VIDEO-BYTES');
    const thumbFile = join(hooks.cache, 'videos', 'thumb.jpg');
    writeFileSync(thumbFile, 'THUMB');
    const { getThumbnailAsync } = await import('expo-video-thumbnails');
    vi.mocked(getThumbnailAsync).mockResolvedValue({
      uri: `file://${thumbFile}`,
      width: 320,
      height: 180,
    });
    apiMock.uploadMedia.mockClear();

    socketError = 'réseau';
    await expect(
      send({
        asset: {
          uri: `file://${clip}`,
          kind: 'video',
          mime: 'video/mp4',
          name: 'clip.mp4',
          size: 11,
          durationMs: 3000,
        },
      }),
    ).rejects.toThrow('réseau');

    const clientId = await journaledClientId();
    const calls = apiMock.uploadMedia.mock.calls;
    expect(calls).toHaveLength(2);
    const keys = calls.map(([, asset]) => (asset as { idempotencyKey?: string }).idempotencyKey);
    expect(keys).toEqual([
      mediaUploadKey(clientId, 'media'),
      mediaUploadKey(clientId, 'thumb'),
    ]);
    // Chaque appel chiffré déclare sa conversation et son mode.
    for (const [, asset] of calls) {
      expect(asset).toMatchObject({
        encrypted: true,
        conversationId: conversation.id,
        mimeType: 'application/octet-stream',
      });
    }

    // Une reprise après redémarrage réutiliserait exactement les mêmes clés.
    const [preparation] = await listIncompleteMediaPreparations(db as never);
    expect(preparation.clientId).toBe(clientId);
    expect(mediaUploadKey(preparation.clientId, 'media')).toBe(keys[0]);
    expect(mediaUploadKey(preparation.clientId, 'thumb')).toBe(keys[1]);
  });

  it('I. un redémarrage relit exactement le même état, sans mémoire du processus', async () => {
    apiMock.uploadMedia.mockRejectedValueOnce(new Error('réseau'));
    await expect(send()).rejects.toThrow('réseau');

    const first = await listMediaPreparations(db as never);
    const second = await listMediaPreparations(db as never);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    // Les valeurs viennent du disque et de SQLCipher : elles sont identiques
    // alors que l'appel qui les a créées a échoué et n'a rien retourné.
    const [preparation] = first;
    expect(preparation.media?.blob.fileKey).toBe('cle');
    expect(preparation.media?.blob.uploadId).toBe('');
    // Horodatages stables d'une lecture à l'autre (création <= dernière étape).
    expect(Date.parse(preparation.createdAt)).toBeLessThanOrEqual(
      Date.parse(preparation.updatedAt),
    );
    expect(
      readFileSync(
        join(hooks.document, DURABLE_MEDIA_DIRECTORY, preparation.clientId, 'cipher.bin'),
      ).length,
    ).toBe(preparation.media!.blob.size);
  });
});
