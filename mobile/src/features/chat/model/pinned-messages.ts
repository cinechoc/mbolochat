import AsyncStorage from '@react-native-async-storage/async-storage';

export const MAX_PINNED_MESSAGES = 20;
const STORAGE_PREFIX = 'mbolo.chat.pinned.v1:';

export function pinnedMessagesStorageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`;
}

/** Lit une liste persistée sans jamais laisser passer une valeur invalide. */
export function parsePinnedMessageIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const unique: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string' || value.length === 0 || unique.includes(value)) continue;
      unique.push(value);
      if (unique.length >= MAX_PINNED_MESSAGES) break;
    }
    return unique;
  } catch {
    return [];
  }
}

export function togglePinnedMessageId(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((value) => value !== id);
  return [id, ...ids].slice(0, MAX_PINNED_MESSAGES);
}

export async function loadPinnedMessageIds(conversationId: string): Promise<string[]> {
  try {
    return parsePinnedMessageIds(
      await AsyncStorage.getItem(pinnedMessagesStorageKey(conversationId)),
    );
  } catch {
    return [];
  }
}

export async function savePinnedMessageIds(
  conversationId: string,
  ids: readonly string[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      pinnedMessagesStorageKey(conversationId),
      JSON.stringify(ids.slice(0, MAX_PINNED_MESSAGES)),
    );
  } catch {
    // Le pin reste valable pour la session si le stockage local échoue.
  }
}
