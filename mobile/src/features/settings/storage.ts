import {
  cacheDirectory,
  deleteAsync,
  getInfoAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy';

/** Taille du cache de l'application (images, pièces jointes temporaires). */
export async function cacheSizeBytes(): Promise<number> {
  if (!cacheDirectory) {
    return 0;
  }
  const walk = async (uri: string): Promise<number> => {
    try {
      const info = await getInfoAsync(uri);
      if (!info.exists) {
        return 0;
      }
      if (!info.isDirectory) {
        return info.size ?? 0;
      }
      const names = await readDirectoryAsync(uri);
      let total = 0;
      for (const name of names) {
        total += await walk(`${uri}${uri.endsWith('/') ? '' : '/'}${name}`);
      }
      return total;
    } catch {
      return 0;
    }
  };
  return walk(cacheDirectory);
}

/** Vide le cache, jamais les données du compte (base locale, jetons). */
export async function clearAppCache(): Promise<void> {
  if (!cacheDirectory) {
    return;
  }
  try {
    const names = await readDirectoryAsync(cacheDirectory);
    for (const name of names) {
      await deleteAsync(`${cacheDirectory}${cacheDirectory.endsWith('/') ? '' : '/'}${name}`, {
        idempotent: true,
      });
    }
  } catch {
    /* cache déjà vide ou inaccessible */
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} o`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} Ko`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}
