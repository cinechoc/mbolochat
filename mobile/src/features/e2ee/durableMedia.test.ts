import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveLocalMessage } from './db';
import {
  DURABLE_MEDIA_DIRECTORY,
  attachDurableMedia,
  durableMediaFileUri,
  durableMediaIdFromUri,
  durableMediaSize,
  durableMediaUri,
  loadMessageDurableMedia,
  newDurableMediaId,
  removeDurableMedia,
  storeDurableMedia,
  sweepDurableMedia,
  sweepDurablePartials,
  sweepSecureMedia,
  verifyDurableMedia,
} from './mediaStore';
import { migrateE2eeSchema } from './schema';

/**
 * `expo-file-system` est remplacé par une implémentation qui écrit **vraiment**
 * sur le disque (`node:fs`), dans deux dossiers temporaires. L'atomicité du
 * renommage, la troncature d'une copie interrompue ou l'existence après
 * « redémarrage » ne se démontrent pas avec un mock en mémoire.
 */
const hooks = vi.hoisted(() => ({
  document: '',
  cache: '',
  /** Coupe une copie après N octets, comme un processus tué en pleine écriture. */
  failCopyAfterBytes: null as number | null,
}));

vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: { decryptFile: vi.fn(), encryptFile: vi.fn() },
}));

vi.mock('@/lib/config', () => ({ API_URL: 'http://localhost:3001' }));

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
        ...uris.map((uri) =>
          typeof uri === 'string' ? toPath(uri) : (uri as ShimDirectory).path,
        ),
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
    createDirectory(name: string) {
      const child = new ShimDirectory(this.path, name);
      child.create({ intermediates: true });
      return child;
    }
    delete() {
      fsp.rmSync(this.path, { recursive: true, force: true });
    }
    list() {
      if (!this.exists) return [];
      return fsp
        .readdirSync(this.path)
        .map((name) => {
          const child = nodePath.join(this.path, name);
          return fsp.statSync(child).isDirectory()
            ? new ShimDirectory(child)
            : new ShimFile(child);
        });
    }
  }

  class ShimFile {
    path: string;
    constructor(...uris: (string | ShimDirectory | ShimFile)[]) {
      this.path = nodePath.join(
        ...uris.map((uri) =>
          typeof uri === 'string' ? toPath(uri) : (uri as ShimFile).path,
        ),
      );
    }
    get uri() {
      return toUri(this.path);
    }
    get exists() {
      return fsp.existsSync(this.path) && fsp.statSync(this.path).isFile();
    }
    get size() {
      try {
        return fsp.statSync(this.path).size;
      } catch {
        return 0;
      }
    }
    get md5() {
      return null;
    }
    async write(content: string | Uint8Array) {
      fsp.writeFileSync(this.path, content as never);
    }
    async text() {
      return fsp.readFileSync(this.path, 'utf8');
    }
    async base64() {
      return fsp.readFileSync(this.path).toString('base64');
    }
    delete() {
      fsp.rmSync(this.path, { force: true });
    }
    async copy(destination: ShimDirectory | ShimFile, options?: { overwrite?: boolean }) {
      const target = (destination as ShimFile).path;
      if (fsp.existsSync(target) && !options?.overwrite) {
        throw new Error('destination_exists');
      }
      const buffer = fsp.readFileSync(this.path);
      if (hooks.failCopyAfterBytes !== null) {
        // Écriture partielle puis échec : exactement ce que laisse un arrêt.
        fsp.writeFileSync(target, buffer.subarray(0, hooks.failCopyAfterBytes));
        throw new Error('copy_interrupted');
      }
      fsp.writeFileSync(target, buffer);
    }
    async move(destination: ShimDirectory | ShimFile, options?: { overwrite?: boolean }) {
      const target = (destination as ShimFile).path;
      if (fsp.existsSync(target) && !options?.overwrite) {
        throw new Error('destination_exists');
      }
      // `rename` : atomique dans un même système de fichiers, écrase la cible.
      fsp.renameSync(this.path, target);
      // Fidélité à expo-file-system : `move()` mute l'instance, dont l'uri
      // devient la destination. Un code qui réutilise l'instance source après
      // coup vise donc la cible — et non plus le temporaire.
      this.path = target;
    }
    static async downloadFileAsync() {
      throw new Error('no_network_in_tests');
    }
  }

  const paths = {
    get document() {
      return new ShimDirectory(hooks.document);
    },
    get cache() {
      return new ShimDirectory(hooks.cache);
    },
  };

  return { Directory: ShimDirectory, File: ShimFile, Paths: paths };
});

interface Handle {
  execAsync(sql: string): Promise<void>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: Handle) => Promise<void>): Promise<void>;
}

function openDb(): { raw: DatabaseSync; db: never } {
  const raw = new DatabaseSync(':memory:');
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = (mode: string) => (task: (txn: Handle) => Promise<void>) => {
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
  return { raw, db: handle as never };
}

/** Fichier source (ciphertext produit ailleurs, ici un contenu opaque). */
function sourceFile(name: string, bytes: Buffer): string {
  const target = join(hooks.cache, name);
  writeFileSync(target, bytes);
  return `file://${target}`;
}

const durableDir = (id: string) => join(hooks.document, DURABLE_MEDIA_DIRECTORY, id);
const filesIn = (id: string): string[] => {
  try {
    return readdirSync(durableDir(id)).sort();
  } catch {
    return [];
  }
};

beforeEach(() => {
  hooks.document = mkdtempSync(join(tmpdir(), 'mbolo-doc-'));
  hooks.cache = mkdtempSync(join(tmpdir(), 'mbolo-cache-'));
  hooks.failCopyAfterBytes = null;
});

afterEach(() => {
  rmSync(hooks.document, { recursive: true, force: true });
  rmSync(hooks.cache, { recursive: true, force: true });
});

describe('storeDurableMedia — écriture durable', () => {
  it('copie le ciphertext et le retrouve par son identifiant', async () => {
    const id = newDurableMediaId();
    const payload = Buffer.from('ciphertext-du-media');
    const source = sourceFile('media.bin', payload);

    const stored = await storeDurableMedia({ id, sourceUri: source });

    expect(stored.reused).toBe(false);
    expect(stored.size).toBe(payload.length);
    expect(durableMediaUri(id)).toBe(stored.uri);
    expect(durableMediaSize(id)).toBe(payload.length);
    // Le contenu copié est bien celui de la source, octet pour octet.
    expect(readFileSync(join(durableDir(id), 'cipher.bin'))).toEqual(payload);
  });

  it('ne réécrit pas un média déjà stocké (réutilisation)', async () => {
    const id = newDurableMediaId();
    const first = sourceFile('a.bin', Buffer.from('version-1'));
    await storeDurableMedia({ id, sourceUri: first });

    const second = sourceFile('b.bin', Buffer.from('version-2'));
    const stored = await storeDurableMedia({ id, sourceUri: second });

    expect(stored.reused).toBe(true);
    // Le fichier existant n'a pas été remplacé.
    expect(readFileSync(join(durableDir(id), 'cipher.bin'), 'utf8')).toBe('version-1');
  });

  it('remplace le média quand la réutilisation n’est pas voulue', async () => {
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('a.bin', Buffer.from('version-1')) });
    const stored = await storeDurableMedia({
      id,
      sourceUri: sourceFile('b.bin', Buffer.from('version-2')),
      overwrite: true,
    });
    expect(stored.reused).toBe(false);
    expect(readFileSync(join(durableDir(id), 'cipher.bin'), 'utf8')).toBe('version-2');
  });

  it('ne laisse aucun temporaire quand tout se passe bien', async () => {
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('m.bin', Buffer.from('ok')) });
    expect(filesIn(id)).toEqual(['cipher.bin']);
  });

  it('refuse une source absente ou vide', async () => {
    await expect(
      storeDurableMedia({ id: newDurableMediaId(), sourceUri: 'file:///inexistant.bin' }),
    ).rejects.toThrow('durable_source_missing');

    const empty = sourceFile('vide.bin', Buffer.alloc(0));
    await expect(storeDurableMedia({ id: newDurableMediaId(), sourceUri: empty })).rejects.toThrow(
      'durable_source_empty',
    );
  });

  it('refuse une taille inattendue sans publier de fichier final', async () => {
    const id = newDurableMediaId();
    const source = sourceFile('m.bin', Buffer.from('12345'));
    await expect(
      storeDurableMedia({ id, sourceUri: source, expectedSize: 99 }),
    ).rejects.toThrow('durable_write_incomplete');
    expect(durableMediaUri(id)).toBeNull();
    expect(filesIn(id)).toEqual([]);
  });
});

describe('storeDurableMedia — interruption', () => {
  it('un écrivain tué en pleine copie ne produit aucun média valide', async () => {
    const id = newDurableMediaId();
    const source = sourceFile('m.bin', Buffer.from('contenu-complet-du-ciphertext'));
    hooks.failCopyAfterBytes = 7;

    await expect(storeDurableMedia({ id, sourceUri: source })).rejects.toThrow('copy_interrupted');

    // Aucun fichier final : le média n'est jamais présenté comme valide.
    expect(durableMediaUri(id)).toBeNull();
    expect(verifyDurableMedia({ id })).toEqual({ ok: false, reason: 'missing' });
    // L'échec est rattrapé : le temporaire tronqué ne survit pas non plus.
    expect(filesIn(id)).toEqual([]);
  });

  it('ignore un temporaire laissé par une session précédente', async () => {
    const id = newDurableMediaId();
    mkdirSync(durableDir(id), { recursive: true });
    writeFileSync(join(durableDir(id), 'cipher.bin.abc.part'), 'moitié');

    expect(durableMediaUri(id)).toBeNull();
    expect(durableMediaSize(id)).toBeNull();

    // Un processus tué, lui, ne passe par aucun `finally` : c'est le balayage
    // de démarrage qui retire ces restes, sans toucher aux fichiers finaux.
    sweepDurablePartials();
    expect(filesIn(id)).toEqual([]);

    // Une écriture réelle aboutit dans le même dossier sans être gênée.
    const stored = await storeDurableMedia({
      id,
      sourceUri: sourceFile('m.bin', Buffer.from('complet')),
    });
    expect(stored.size).toBe(7);
    expect(durableMediaUri(id)).toBe(stored.uri);
  });

  it('survit à un redémarrage là où le cache est balayé', async () => {
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('m.bin', Buffer.from('durable')) });

    // `sweepSecureMedia()` est appelé à chaque démarrage : il vide les clairs
    // lus et les temporaires, jamais le stockage durable.
    sweepSecureMedia();

    expect(durableMediaUri(id)).not.toBeNull();
    expect(verifyDurableMedia({ id, expectedSize: 7 })).toEqual({ ok: true });
  });

  it('deux écritures concurrentes du même média donnent un fichier complet', async () => {
    const id = newDurableMediaId();
    const bytes = Buffer.from('abcdefghij');
    const first = sourceFile('a.bin', bytes);
    const second = sourceFile('b.bin', bytes);

    const [one, two] = await Promise.all([
      storeDurableMedia({ id, sourceUri: first }),
      storeDurableMedia({ id, sourceUri: second }),
    ]);

    expect(one.size).toBe(bytes.length);
    expect(two.size).toBe(bytes.length);
    expect(filesIn(id)).toEqual(['cipher.bin']);
    expect(verifyDurableMedia({ id, expectedSize: bytes.length })).toEqual({ ok: true });
  });
});

describe('médias durables — chemins et suppression', () => {
  it('refuse un identifiant qui sortirait de son dossier', async () => {
    const source = sourceFile('m.bin', Buffer.from('x'));
    for (const id of ['../evil', '..', '', 'a/b', 'a\\b']) {
      await expect(storeDurableMedia({ id, sourceUri: source })).rejects.toThrow(
        'invalid_media_id',
      );
    }
  });

  it('retrouve un média depuis son URI, et rejette tout autre chemin', async () => {
    const id = newDurableMediaId();
    const stored = await storeDurableMedia({
      id,
      sourceUri: sourceFile('m.bin', Buffer.from('x')),
    });

    expect(durableMediaIdFromUri(stored.uri)).toEqual({ id, kind: 'media' });
    expect(durableMediaIdFromUri(durableMediaFileUri(id, 'thumb'))).toEqual({
      id,
      kind: 'thumb',
    });
    expect(durableMediaIdFromUri('file:///cache/mbolo-e2ee-media/x/cipher.bin')).toBeNull();
    expect(durableMediaIdFromUri('cipher.bin')).toBeNull();
    expect(
      durableMediaIdFromUri(`file:///doc/${DURABLE_MEDIA_DIRECTORY}/..%2F..%2Fetc/cipher.bin`),
    ).toBeNull();
  });

  it('supprime média et vignette ensemble, ou l’un seulement', async () => {
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('m.bin', Buffer.from('m')) });
    await storeDurableMedia({
      id,
      kind: 'thumb',
      sourceUri: sourceFile('t.bin', Buffer.from('t')),
    });
    expect(filesIn(id)).toEqual(['cipher.bin', 'thumb-cipher.bin']);

    removeDurableMedia(id, 'thumb');
    expect(filesIn(id)).toEqual(['cipher.bin']);

    removeDurableMedia(id);
    expect(filesIn(id)).toEqual([]);
    expect(durableMediaUri(id)).toBeNull();
    // Idempotent : rien à supprimer n'est pas une erreur.
    expect(() => removeDurableMedia(id)).not.toThrow();
  });

  it('sweepDurableMedia vide tout le stockage durable', async () => {
    const one = newDurableMediaId();
    const two = newDurableMediaId();
    await storeDurableMedia({ id: one, sourceUri: sourceFile('a.bin', Buffer.from('a')) });
    await storeDurableMedia({ id: two, sourceUri: sourceFile('b.bin', Buffer.from('b')) });

    sweepDurableMedia();

    expect(durableMediaUri(one)).toBeNull();
    expect(durableMediaUri(two)).toBeNull();
  });

  it('ne contient que du ciphertext, jamais un clair', async () => {
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('cli-photo.jpg', Buffer.from('c1')) });
    await storeDurableMedia({
      id,
      kind: 'thumb',
      sourceUri: sourceFile('cli-thumb.jpg', Buffer.from('c2')),
    });
    // Les noms de fichiers portent le rôle, pas l'origine : rien de l'import
    // (nom d'origine, extension du clair) n'atterrit dans le dossier durable.
    expect(filesIn(id)).toEqual(['cipher.bin', 'thumb-cipher.bin']);
  });
});

describe('médias durables — lien SQLCipher', () => {
  const message = (id: string, conversation = 'conv-1') => ({
    id,
    conversation_id: conversation,
    sender_id: 'me',
    sender_name: 'Moi',
    body: '',
    created_at: '2026-01-01T00:00:00Z',
    client_id: id,
    mine: 1,
    media_meta: null,
    quote_id: null,
  });

  it('refuse de référencer un fichier absent', async () => {
    const { db } = openDb();
    await migrateE2eeSchema(db);
    await saveLocalMessage(db, message('m1'));

    await expect(
      attachDurableMedia({ db, messageId: 'm1', mediaId: newDurableMediaId() }),
    ).rejects.toThrow('durable_file_missing');
  });

  it('écrit l’URI interne et l’identifiant d’upload sur le message', async () => {
    const { db, raw } = openDb();
    await migrateE2eeSchema(db);
    await saveLocalMessage(db, message('m1'));
    const id = newDurableMediaId();
    const stored = await storeDurableMedia({
      id,
      sourceUri: sourceFile('m.bin', Buffer.from('c')),
    });

    const changes = await attachDurableMedia({
      db,
      messageId: 'm1',
      mediaId: id,
      uploadId: 'upload-1',
    });

    expect(changes).toBe(1);
    expect(
      raw.prepare('SELECT local_cipher_uri, upload_id FROM e2ee_messages WHERE id = ?').get('m1'),
    ).toEqual({ local_cipher_uri: stored.uri, upload_id: 'upload-1' });
  });

  it('relit média et vignette, et signale une référence sans fichier', async () => {
    const { db } = openDb();
    await migrateE2eeSchema(db);
    await saveLocalMessage(db, message('m1'));
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('m.bin', Buffer.from('m')) });
    await storeDurableMedia({
      id,
      kind: 'thumb',
      sourceUri: sourceFile('t.bin', Buffer.from('t')),
    });
    await attachDurableMedia({ db, messageId: 'm1', mediaId: id, uploadId: 'u1' });
    await attachDurableMedia({
      db,
      messageId: 'm1',
      mediaId: id,
      kind: 'thumb',
      uploadId: 'u2',
    });

    const complete = await loadMessageDurableMedia(db, 'm1');
    expect(complete.media?.id).toBe(id);
    expect(complete.thumb?.id).toBe(id);
    expect(complete.missing).toEqual([]);

    // Le fichier disparaît (nettoyage système, manipulation) : la référence
    // SQLCipher reste, mais n'est plus présentée comme un média récupérable.
    removeDurableMedia(id, 'media');
    const afterLoss = await loadMessageDurableMedia(db, 'm1');
    expect(afterLoss.media).toBeNull();
    expect(afterLoss.thumb?.id).toBe(id);
    expect(afterLoss.missing).toEqual(['media']);
  });

  it('ne touche pas à l’identifiant d’upload d’un autre rôle', async () => {
    const { db, raw } = openDb();
    await migrateE2eeSchema(db);
    await saveLocalMessage(db, message('m1'));
    const id = newDurableMediaId();
    await storeDurableMedia({ id, sourceUri: sourceFile('m.bin', Buffer.from('m')) });
    await storeDurableMedia({
      id,
      kind: 'thumb',
      sourceUri: sourceFile('t.bin', Buffer.from('t')),
    });
    await attachDurableMedia({ db, messageId: 'm1', mediaId: id, uploadId: 'media-upload' });

    await attachDurableMedia({ db, messageId: 'm1', mediaId: id, kind: 'thumb' });

    expect(
      raw
        .prepare('SELECT upload_id, thumb_upload_id FROM e2ee_messages WHERE id = ?')
        .get('m1'),
    ).toEqual({ upload_id: 'media-upload', thumb_upload_id: null });
  });
});
