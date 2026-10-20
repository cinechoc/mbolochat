import type { ConversationSummary, Message, UserProfile } from './types';

/**
 * Cache en mémoire des données déjà chargées.
 *
 * Objectif : comme sur WhatsApp, revenir sur une discussion ou un profil
 * affiche immédiatement ce qu'on a déjà vu, pendant que le rafraîchissement
 * réseau se fait en arrière-plan.
 *
 * Le cache vit le temps de la session (pas de stockage disque) et expire au
 * bout de CACHE_TTL millisecondes pour ne pas montrer d'informations périmées.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface Entry<T> {
  value: T;
  at: number;
}

const conversations = new Map<string, Entry<ConversationSummary>>();
const conversationLists = new Map<string, Entry<ConversationSummary[]>>();
const messages = new Map<string, Entry<Message[]>>();
const profiles = new Map<string, Entry<UserProfile>>();

function isFresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
  return entry !== undefined && Date.now() - entry.at < CACHE_TTL_MS;
}

export const cache = {
  setConversation(conversation: ConversationSummary) {
    conversations.set(conversation.id, { value: conversation, at: Date.now() });
  },

  getConversation(id: string): ConversationSummary | null {
    const entry = conversations.get(id);
    return isFresh(entry) ? entry.value : null;
  },

  setConversationList(list: ConversationSummary[]) {
    conversationLists.set('list', { value: list, at: Date.now() });
    for (const conversation of list) {
      cache.setConversation(conversation);
    }
  },

  getConversationList(): ConversationSummary[] | null {
    const entry = conversationLists.get('list');
    return isFresh(entry) ? entry.value : null;
  },

  setMessages(conversationId: string, list: Message[]) {
    messages.set(conversationId, { value: list, at: Date.now() });
  },

  getMessages(conversationId: string): Message[] | null {
    const entry = messages.get(conversationId);
    return isFresh(entry) ? entry.value : null;
  },

  setProfile(profile: UserProfile) {
    profiles.set(profile.id, { value: profile, at: Date.now() });
  },

  getProfile(id: string): UserProfile | null {
    const entry = profiles.get(id);
    return isFresh(entry) ? entry.value : null;
  },

  /** Vide le cache (déconnexion, changement de compte). */
  clear() {
    conversations.clear();
    conversationLists.clear();
    messages.clear();
    profiles.clear();
  },
};
