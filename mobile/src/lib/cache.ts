import type { ConversationSummary, Message, UserProfile } from './types';

/**
 * Cache persistant des données déjà chargées.
 *
 * Objectif : comme sur WhatsApp, ouvrir une page affiche directement son
 * contenu (récupéré sur le disque), sans squelette ni spinner. Le
 * rafraîchissement réseau se fait ensuite, en arrière-plan.
 *
 * - une couche mémoire pour les lectures synchrones (instantanées) ;
 * - une couche disque (AsyncStorage) pour survivre au redémarrage de l'app.
 *
 * Le module natif est chargé à la demande : s'il est absent (build EAS
 * antérieur à l'ajout du paquet), l'app continue de fonctionner avec le
 * cache mémoire seul.
 */

interface Storage {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiSet(pairs: readonly (readonly [string, string])[]): Promise<void>;
  setItem(key: string, value: string): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
}

let storage: Storage | null | undefined;

function getStorage(): Storage | null {
  if (storage === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@react-native-async-storage/async-storage') as {
        default?: Storage;
      } & Storage;
      storage = mod.default ?? mod;
    } catch {
      storage = null;
    }
  }
  return storage;
}

/** Appel disque protégé : toute erreur est ignorée (le cache est un confort). */
async function safe<T>(
  action: (store: Storage) => Promise<T>,
  fallback: T,
): Promise<T> {
  const store = getStorage();
  if (!store) {
    return fallback;
  }
  try {
    return await action(store);
  } catch {
    return fallback;
  }
}

const PREFIX = 'mbolo:cache:v1:';
/** Au-delà, la donnée est considérée comme trop ancienne et jetée. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry<T> {
  value: T;
  at: number;
}

const conversations = new Map<string, Entry<ConversationSummary>>();
const conversationLists = new Map<string, Entry<ConversationSummary[]>>();
const messages = new Map<string, Entry<Message[]>>();
const profiles = new Map<string, Entry<UserProfile>>();

/** Écritures groupées : on évite d'écrire sur le disque à chaque message. */
const pendingWrites = new Map<string, string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(key: string, serialized: string) {
  pendingWrites.set(key, serialized);
  if (writeTimer) {
    return;
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const entries = [...pendingWrites.entries()];
    pendingWrites.clear();
    void safe((store) => store.multiSet(entries), undefined);
  }, 400);
}

function isUsable<T>(entry: Entry<T> | undefined): entry is Entry<T> {
  return entry !== undefined && Date.now() - entry.at < MAX_AGE_MS;
}

function parse<T>(raw: string | null): Entry<T> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { value: T; at: number };
    if (!parsed || typeof parsed.at !== 'number') {
      return null;
    }
    return { value: parsed.value, at: parsed.at };
  } catch {
    return null;
  }
}

export const cache = {
  /**
   * Recharge le cache depuis le disque. À appeler une fois au démarrage,
   * avant d'afficher la première page.
   */
  async hydrate(): Promise<void> {
    const keys = await safe(
      async (store) => (await store.getAllKeys()).filter((key) => key.startsWith(PREFIX)),
      [] as string[],
    );
    if (keys.length === 0) {
      return;
    }
    const pairs = await safe((store) => store.multiGet([...keys]), [] as (readonly [string, string | null])[]);
    for (const [key, raw] of pairs) {
      const entry = parse<unknown>(raw);
      if (!entry) {
        continue;
      }
      const id = key.slice(PREFIX.length);
      if (id === 'conversations') {
        const list = entry.value as ConversationSummary[];
        conversationLists.set('list', { value: list, at: entry.at });
        for (const conversation of list) {
          conversations.set(conversation.id, { value: conversation, at: entry.at });
        }
      } else if (id.startsWith('messages:')) {
        messages.set(id.slice('messages:'.length), entry as Entry<Message[]>);
      } else if (id.startsWith('profiles:')) {
        profiles.set(id.slice('profiles:'.length), entry as Entry<UserProfile>);
      }
    }
  },

  setConversation(conversation: ConversationSummary) {
    conversations.set(conversation.id, { value: conversation, at: Date.now() });
  },

  getConversation(id: string): ConversationSummary | null {
    const entry = conversations.get(id);
    return isUsable(entry) ? entry.value : null;
  },

  setConversationList(list: ConversationSummary[]) {
    conversationLists.set('list', { value: list, at: Date.now() });
    for (const conversation of list) {
      cache.setConversation(conversation);
    }
    scheduleWrite(
      `${PREFIX}conversations`,
      JSON.stringify({ value: list, at: Date.now() }),
    );
  },

  getConversationList(): ConversationSummary[] | null {
    const entry = conversationLists.get('list');
    return isUsable(entry) ? entry.value : null;
  },

  setMessages(conversationId: string, list: Message[]) {
    const at = Date.now();
    messages.set(conversationId, { value: list, at });
    // On ne garde que les 50 derniers messages par conversation sur le disque.
    const trimmed = list.slice(-50);
    scheduleWrite(
      `${PREFIX}messages:${conversationId}`,
      JSON.stringify({ value: trimmed, at }),
    );
  },

  getMessages(conversationId: string): Message[] | null {
    const entry = messages.get(conversationId);
    return isUsable(entry) ? entry.value : null;
  },

  setProfile(profile: UserProfile) {
    const at = Date.now();
    profiles.set(profile.id, { value: profile, at });
    scheduleWrite(`${PREFIX}profiles:${profile.id}`, JSON.stringify({ value: profile, at }));
  },

  getProfile(id: string): UserProfile | null {
    const entry = profiles.get(id);
    return isUsable(entry) ? entry.value : null;
  },

  /** Vide le cache (déconnexion, changement de compte). */
  async clear(): Promise<void> {
    conversations.clear();
    conversationLists.clear();
    messages.clear();
    profiles.clear();
    pendingWrites.clear();
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await safe(async (store) => {
      const keys = (await store.getAllKeys()).filter((key) => key.startsWith(PREFIX));
      if (keys.length > 0) {
        await store.multiRemove([...keys]);
      }
    }, undefined);
  },

  /** Force l'écriture immédiate (utilisé à la déconnexion). */
  flush(): void {
    if (pendingWrites.size === 0) {
      return;
    }
    const entries = [...pendingWrites.entries()];
    pendingWrites.clear();
    void safe((store) => store.multiSet(entries), undefined);
  },
};
