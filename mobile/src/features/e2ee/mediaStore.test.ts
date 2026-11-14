import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { refreshAccessToken } from '@/lib/token-refresh';
import {
  extensionForMime,
  fileSystemPath,
  loadThumbnailDataUrl,
  openForView,
  sweepSecureMedia,
} from './mediaStore';

// Le module touche aussi SQLCipher (lien média ↔ message) : ces tests-ci ne
// portent que sur les fichiers, la base n'a pas à être chargée pour de vrai.
vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(),
}));

vi.mock('@/lib/token-refresh', () => ({
  refreshAccessToken: vi.fn(async () => 'jeton-frais'),
}));

/** Système de fichiers simulé : on ne garde que ce qui existe encore. */
const existing = new Set<string>();
let downloadsShouldFail = false;
let nextDownloadStatus: number | null = null;
const queuedDownloadStatuses: number[] = [];
let lastDownload: { url: string; headers?: Record<string, string> } | null = null;
const downloadHeaders: (Record<string, string> | undefined)[] = [];

function join(parts: { uri?: string }[]): string {
  const raw = parts
    .map((part) => (typeof part === 'string' ? part : (part.uri ?? '')))
    .join('/');
  // Le schéma « file:// » garde ses deux barres : on ne compresse les « / »
  // que dans le chemin, comme le fait la classe native.
  const scheme = /^([a-zA-Z][\w+.-]*:\/\/)(.*)$/.exec(raw);
  return scheme ? scheme[1] + scheme[2].replace(/\/{2,}/g, '/') : raw.replace(/\/{2,}/g, '/');
}

/** Fichiers et dossiers laissés **sous** le dossier privé (racine exclue). */
function mediaLeftovers(): string[] {
  return [...existing].filter((path) => path.includes('mbolo-e2ee-media/'));
}

/** Tout ce qui est sous `directory` cesse d'exister, comme un rm -r. */
function removeTree(uri: string): void {
  for (const path of [...existing]) {
    if (path === uri || path.startsWith(`${uri}/`)) existing.delete(path);
  }
}

vi.mock('expo-file-system', () => {
  const DOCUMENT_URI = 'file:///data/user/0/app/files';
  class Directory {
    uri: string;
    constructor(...parts: { uri?: string }[]) {
      this.uri = join(parts);
    }
    get exists(): boolean {
      return existing.has(this.uri);
    }
    /** `intermediates: true` : tous les dossiers parents existent, comme mkdir -p. */
    create(): void {
      existing.add(this.uri);
      const document = join([{ uri: DOCUMENT_URI }]);
      let parent = this.uri.slice(0, this.uri.lastIndexOf('/'));
      while (parent.length >= document.length && parent.startsWith(document)) {
        existing.add(parent);
        parent = parent.slice(0, parent.lastIndexOf('/'));
      }
    }
    delete(): void {
      removeTree(this.uri);
    }
  }
  class File {
    uri: string;
    constructor(...parts: { uri?: string }[]) {
      this.uri = join(parts);
    }
    get exists(): boolean {
      return existing.has(this.uri);
    }
    delete(): void {
      existing.delete(this.uri);
    }
    static downloadFileAsync(
      url: string,
      destination: File,
      options?: { headers?: Record<string, string> },
    ): Promise<File> {
      lastDownload = { url, headers: options?.headers };
      downloadHeaders.push(options?.headers);
      const queuedStatus = queuedDownloadStatuses.shift() ?? null;
      const status = queuedStatus ?? nextDownloadStatus;
      if (status !== null) {
        nextDownloadStatus = null;
        return Promise.reject(
          new Error(`Unable to download a file: response has status: ${status}`),
        );
      }
      if (downloadsShouldFail) return Promise.reject(new Error('UnableToDownload 404'));
      existing.add(destination.uri);
      return Promise.resolve(destination);
    }
    async base64(): Promise<string> {
      return 'ZmFrZQ==';
    }
  }
  return {
    Directory,
    File,
    Paths: { document: { uri: 'file:///data/user/0/app/files' }, cache: { uri: 'file:///cache' } },
  };
});

vi.mock('../../../modules/mbolo-crypto/src', () => ({
  MboloCrypto: { decryptFile: vi.fn() },
}));

// `@/lib/config` tire react-native (Flow) : on fige l'URL de l'API pour garder
// ces tests sur la seule logique du dossier privé.
vi.mock('@/lib/config', () => ({ API_URL: 'http://api.test' }));

const cryptoMock = vi.mocked(MboloCrypto);
const blob = {
  uploadId: 'upload-1',
  fileKey: 'Zm9v',
  nonce: 'bm9v',
  sha256: 'ab'.repeat(32),
  size: 10,
};

beforeEach(() => {
  existing.clear();
  downloadsShouldFail = false;
  nextDownloadStatus = null;
  queuedDownloadStatuses.length = 0;
  lastDownload = null;
  downloadHeaders.length = 0;
  vi.clearAllMocks();
  cryptoMock.decryptFile.mockResolvedValue({ plaintext_size: 10 } as never);
  vi.mocked(refreshAccessToken).mockResolvedValue('jeton-frais');
});

describe('médias chiffrés — dossier privé', () => {
  it('nomme le clair selon le type MIME', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('video/mp4; charset=binary')).toBe('mp4');
    expect(extensionForMime('application/x-inconnu')).toBe('bin');
  });

  it('décode le chemin système attendu par le natif', () => {
    expect(fileSystemPath('file:///data/user/0/app/files')).toBe('/data/user/0/app/files');
  });

  it('télécharge le ciphertext authentifié puis déchiffre dans le dossier du média', async () => {
    const uri = await openForView({ token: 'jeton', blob, mime: 'image/jpeg' });
    expect(lastDownload?.url).toContain('/uploads/upload-1');
    expect(lastDownload?.headers?.Authorization).toBe('Bearer jeton');
    expect(uri).toContain('mbolo-e2ee-media/upload-1/plain.jpg');
    expect(cryptoMock.decryptFile).toHaveBeenCalledTimes(1);
    const [input, output] = cryptoMock.decryptFile.mock.calls[0] as unknown as string[];
    expect(input).toContain('cipher.bin');
    expect(output).toContain('plain.jpg');
  });

  it('ne laisse aucun reste quand le déchiffrement échoue (empreinte refusée)', async () => {
    cryptoMock.decryptFile.mockRejectedValue(new Error('sha256_mismatch'));
    await expect(openForView({ token: 'jeton', blob, mime: 'image/jpeg' })).rejects.toThrow(
      'sha256_mismatch',
    );
    expect(mediaLeftovers()).toHaveLength(0);
  });

  it('rafraîchit le jeton et rejoue une fois après un 401', async () => {
    nextDownloadStatus = 401;
    const uri = await openForView({ token: 'jeton-expire', blob, mime: 'image/jpeg' });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(downloadHeaders.map((headers) => headers?.Authorization)).toEqual([
      'Bearer jeton-expire',
      'Bearer jeton-frais',
    ]);
    expect(uri).toContain('mbolo-e2ee-media/upload-1/plain.jpg');
    expect(cryptoMock.decryptFile).toHaveBeenCalledTimes(1);
  });

  it('ne rafraîchit pas le jeton sur une erreur qui n’est pas un 401', async () => {
    nextDownloadStatus = 404;
    await expect(openForView({ token: 'jeton', blob, mime: 'image/jpeg' })).rejects.toThrow();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(mediaLeftovers()).toHaveLength(0);
  });

  it('ne rejoue qu’une seule fois quand la nouvelle tentative est encore refusée', async () => {
    queuedDownloadStatuses.push(401, 401);
    await expect(
      openForView({ token: 'jeton-expire', blob, mime: 'image/jpeg' }),
    ).rejects.toThrow('status: 401');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(downloadHeaders.map((headers) => headers?.Authorization)).toEqual([
      'Bearer jeton-expire',
      'Bearer jeton-frais',
    ]);
    expect(mediaLeftovers()).toHaveLength(0);
  });

  it('ne relance pas de téléchargement si le rafraîchissement échoue', async () => {
    nextDownloadStatus = 401;
    vi.mocked(refreshAccessToken).mockRejectedValue(new Error('Refresh failed (401)'));
    await expect(openForView({ token: 'jeton-expire', blob, mime: 'image/jpeg' })).rejects.toThrow(
      'Refresh failed (401)',
    );
    expect(downloadHeaders).toHaveLength(1);
    expect(mediaLeftovers()).toHaveLength(0);
  });

  it('ne laisse aucun reste quand le téléchargement échoue', async () => {
    downloadsShouldFail = true;
    await expect(openForView({ token: 'jeton', blob, mime: 'video/mp4' })).rejects.toThrow();
    expect(mediaLeftovers()).toHaveLength(0);
  });

  it('refuse un identifiant d’upload qui sortirait de son dossier', async () => {
    await expect(
      openForView({
        token: 'jeton',
        blob: { ...blob, uploadId: '../../secret' },
        mime: 'image/jpeg',
      }),
    ).rejects.toThrow('invalid_media_id');
  });

  it('le balayage efface tout le dossier des médias', async () => {
    await openForView({ token: 'jeton', blob, mime: 'image/jpeg' });
    expect(existing.size).toBeGreaterThan(0);
    sweepSecureMedia();
    // Rien ne subsiste sous le dossier privé ; le reste du domaine documentaire
    // n'appartient pas au média et n'est pas touché.
    expect(mediaLeftovers()).toHaveLength(0);
  });
});

describe('vignette chiffrée — mémoire seule', () => {
  it('renvoie une data URI du bon MIME et ne laisse rien sur le disque', async () => {
    const dataUrl = await loadThumbnailDataUrl({ token: 'jeton', blob, mime: 'image/jpeg' });
    expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Contrairement au média complet, la vignette ne laisse même pas de
    // dossier : le clair est relu puis effacé dans la foulée.
    expect(mediaLeftovers()).toHaveLength(0);
  });

  it('ne laisse aucun reste quand le déchiffrement de la vignette échoue', async () => {
    cryptoMock.decryptFile.mockRejectedValue(new Error('sha256_mismatch'));
    await expect(
      loadThumbnailDataUrl({ token: 'jeton', blob, mime: 'image/jpeg' }),
    ).rejects.toThrow('sha256_mismatch');
    expect(mediaLeftovers()).toHaveLength(0);
  });
});
