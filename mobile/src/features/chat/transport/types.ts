import type { E2eeInitFailure } from '@/features/e2ee/initState';
import type { RecentGif } from '@/features/media/GifPanel';
import type { PersonalSticker } from '@/features/stickers/stickerLibrary';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import type { TextSendOptions } from '../model/send-options';
import type {
  ConversationSummary,
  Gender,
  MessageAttachmentType,
  MessageQuote,
  MessageReceipt,
  MessageType,
  ReactionSummary,
} from '@/lib/types';

/** Mode retenu pour une conversation, figé à l'ouverture de l'écran. */
export type ChatMode = 'classic' | 'e2ee';

/**
 * Source unique de vérité de l'interface : elle ne consulte jamais `mode`
 * pour décider ce qu'elle affiche, seulement ces drapeaux.
 */
export interface ChatCapabilities {
  replies: boolean;
  reactions: boolean;
  deleteForEveryone: boolean;
  stickers: boolean;
  gifs: boolean;
  /** Transfert de texte vers une autre conversation du même type. */
  forwarded: boolean;
  voice: boolean;
  typing: boolean;
  edit: boolean;
  ephemeral: boolean;
  calls: boolean;
  albums: boolean;
  groups: boolean;
  encrypted: boolean;
  pagination: 'server' | 'local';
  receipts: 'ticks' | 'delivered-opened';
  /** Programmation, envoi silencieux et lecture unique (mode clair uniquement). */
  sendOptions: boolean;
}

/** Capacités qui commandent une méthode et peuvent donc être refusées. */
export type GatedCapability =
  | 'replies'
  | 'reactions'
  | 'deleteForEveryone'
  | 'stickers'
  | 'gifs'
  | 'forwarded'
  | 'voice'
  | 'typing'
  | 'edit'
  | 'ephemeral'
  | 'calls'
  | 'sendOptions';

/** Refus typé d'une méthode non supportée par le mode courant. */
export class UnsupportedCapabilityError extends Error {
  readonly code = 'unsupported_capability';

  constructor(readonly capability: GatedCapability) {
    super(`Capacité non prise en charge : ${capability}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/**
 * Anti-downgrade : un transport classique ne s'instancie jamais pour une
 * conversation marquée chiffrée, même si l'appelant se trompe de mode.
 */
export class EncryptedConversationError extends Error {
  readonly code = 'encrypted_conversation';

  constructor(readonly conversationId: string) {
    super('Conversation chiffrée : le transport classique est refusé');
    this.name = 'EncryptedConversationError';
  }
}

/** Anti-downgrade inverse : le transport chiffré refuse une conversation claire. */
export class PlaintextConversationError extends Error {
  readonly code = 'plaintext_conversation';

  constructor(readonly conversationId: string) {
    super('Conversation non chiffrée : le transport E2EE est refusé');
    this.name = 'PlaintextConversationError';
  }
}

export interface ChatIdentity {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  gender: Gender | null;
  genderCustom: string | null;
}

export interface ChatAttachmentView {
  type: MessageAttachmentType;
  /** URL signée (clair) ; null pour un média chiffré non déchiffré. */
  url: string | null;
  encrypted: boolean;
  /** Référence JSON du média chiffré (SQLCipher), sinon null. */
  mediaMeta: string | null;
  mime: string | null;
  name: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Identifiant local d'un sticker personnel, null pour un sticker reçu. */
  stickerId: string | null;
  /** Pack d'origine d'un sticker personnel. */
  stickerPackId: string | null;
  stickerName: string | null;
  giphy: {
    giphyId: string | null;
    username: string | null;
    title: string | null;
    stillUrl: string | null;
    sticker: boolean;
  } | null;
}

export type ChatDeliveryState =
  | 'none'
  | 'pending'
  | 'failed'
  | 'sent'
  | 'delivered'
  | 'read';

/** Vue unique d'un message, quel que soit le transport qui l'a produit. */
export interface ChatMessageView {
  id: string;
  clientId: string | null;
  conversationId: string;
  mine: boolean;
  sender: ChatIdentity;
  createdAt: string;
  body: string;
  type: MessageType;
  deleted: boolean;
  /** Contenu authentifié mais illisible (E2EE) : jamais de détail exposé. */
  unreadable: boolean;
  /** Texte modifié au moins une fois (mode chiffré). */
  edited: boolean;
  /** Dernière révision de modification, 0 si aucune. */
  editRevision: number;
  quoteId: string | null;
  quote: MessageQuote | null;
  reactions: ReactionSummary[];
  /** Envoi silencieux (mode clair). */
  silent?: boolean;
  /** Lecture unique : contenu masqué jusqu’à ouverture. */
  viewOnce?: boolean;
  /** Date programme locale, seulement pour une bulle en attente. */
  scheduledAt?: string | null;
  stickerRef: string | null;
  attachment: ChatAttachmentView | null;
  state: ChatDeliveryState;
  error: string | null;
  progress: number | null;
}

/** Média sortant commun aux deux transports. */
export interface OutgoingAsset {
  uri: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  mime: string | null;
  name: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform?: number[];
}

export interface ChatSnapshot {
  messages: ChatMessageView[];
  receipts: Record<string, MessageReceipt[]>;
  hasMore: boolean;
  unreadCount: number;
  ephemeralSeconds: number;
}

export interface ChatPage {
  messages: ChatMessageView[];
  hasMore: boolean;
}

export interface ChatTransportHandlers {
  onMessage(message: ChatMessageView): void;
  onMessageRemoved(id: string, forEveryone: boolean): void;
  onReceipts(receipts: MessageReceipt[]): void;
  onReaction(messageId: string, reactions: ReactionSummary[]): void;
  onTyping(state: { userId: string; text: string } | null): void;
  onEphemeral?(ttlSeconds: number): void;
  onConnection(online: boolean): void;
  onConversationUpdated(summary: ConversationSummary): void;
  onConversationRemoved(): void;
  onError(error: string | null): void;
  onFatal(failure: E2eeInitFailure | null): void;
}

/**
 * Frontière unique entre l'écran et les deux pipelines.
 *
 * Toutes les méthodes existent dans les deux implémentations. Une capacité
 * absente ne se traduit pas par une méthode manquante mais par un
 * `UnsupportedCapabilityError` : l'interface, elle, ne se fie qu'à
 * `capabilities` pour proposer ou non une action.
 */
export interface ChatTransport {
  readonly mode: ChatMode;
  readonly conversationId: string;
  readonly capabilities: ChatCapabilities;

  loadInitial(): Promise<ChatSnapshot>;
  loadOlder(beforeCreatedAt: string, beforeId?: string): Promise<ChatPage>;
  subscribe(handlers: ChatTransportHandlers): () => void;
  dispose(): Promise<void>;

  sendText(
    text: string,
    replyToId: string | null,
    options?: TextSendOptions,
  ): Promise<void>;
  sendMedia(asset: OutgoingAsset, caption: string, replyToId: string | null): Promise<void>;
  sendSticker(ref: string): Promise<void>;
  sendPersonalSticker(sticker: PersonalSticker): Promise<void>;
  sendGif(gif: RecentGif): Promise<void>;
  sendVoice(note: VoiceNote): Promise<void>;
  /** Transfère un texte vers une autre conversation, si la capacité l'autorise. */
  forwardText(target: ConversationSummary, text: string): Promise<void>;

  deleteMessage(id: string, forEveryone: boolean): Promise<void>;
  /** Efface une lecture unique localement, puis masque la copie serveur sans bloquer. */
  consumeViewOnce?: (id: string) => Promise<void>;
  editMessage(id: string, text: string): Promise<void>;
  toggleReaction(id: string, reaction: string): Promise<void>;
  markRead(ids?: string[]): Promise<void>;
  reportDelivered(ids: string[]): void;
  setTyping(active: boolean, text?: string): void;
  setEphemeral(ttlSeconds: number): Promise<void>;
  getEphemeralSeconds(): Promise<number>;
  saveDraft(text: string): void;
  loadDraft(): Promise<string>;
  retry(id: string): void;
  discard(id: string): Promise<void>;
}
