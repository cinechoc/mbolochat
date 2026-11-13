import type { OutboxItem } from '@/lib/store';
import type { RecentGif } from '@/features/media/GifPanel';
import type { PersonalSticker } from '@/features/stickers/stickerLibrary';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import { tickState } from '@/lib/format';
import type {
  ConversationSummary,
  Message,
  MessageReceipt,
  ReactionSummary,
} from '@/lib/types';
import { classicMessageToView } from '../model/message-view';
import { groupReceipts, mergeMessages, quoteOfMessage } from '../model/merge';
import type { ClassicTransportDeps, ClassicTransportOptions } from './deps';
import {
  EncryptedConversationError,
  UnsupportedCapabilityError,
  type ChatCapabilities,
  type ChatMessageView,
  type ChatPage,
  type ChatSnapshot,
  type ChatTransport,
  type ChatTransportHandlers,
  type OutgoingAsset,
} from './types';

/** Taille de page historique, comme l'écran classique. */
const PAGE_SIZE = 30;

/** Valeur de `stickerLibrary.PERSONAL_PACK_ID`, sans charger le module natif. */
const PERSONAL_STICKER_PACK_ID = 'mes-stickers';

const CLASSIC_CAPABILITIES: ChatCapabilities = {
  replies: true,
  reactions: true,
  deleteForEveryone: true,
  stickers: true,
  gifs: true,
  forwarded: false,
  voice: true,
  typing: true,
  calls: true,
  albums: true,
  groups: true,
  encrypted: false,
  pagination: 'server',
  receipts: 'ticks',
};

interface DeletedPayload {
  conversationId?: string;
  messageId?: string;
  forEveryone?: boolean;
}

interface ReceiptPayload {
  receipts?: MessageReceipt[];
}

interface TypingPayload {
  conversationId: string;
  userId: string;
  typing?: boolean;
  text?: string;
}

interface ReactionPayload {
  conversationId: string;
  messageId: string;
  reactions: ReactionSummary[];
}

interface GroupEvent {
  conversationId: string;
  group: {
    name: string | null;
    description: string | null;
    emoji: string | null;
    color: string | null;
    avatarUrl: string | null;
    ownerId: string | null;
    whoCanSend: 'all' | 'admins';
    whoCanAdd: 'all' | 'admins';
    updatedAt: string;
  };
  members: ConversationSummary['members'];
}

/**
 * Transport de la conversation historique (messages en clair).
 *
 * Il encapsule le cache local, l'outbox SQLite et les événements du socket.
 * Toutes les dépendances sont injectées ; aucun module n'est importé à
 * l'exécution, ce qui permet de le tester avec des faux.
 */
export class ClassicTransport implements ChatTransport {
  readonly mode = 'classic' as const;
  readonly capabilities = CLASSIC_CAPABILITIES;
  readonly conversationId: string;

  private readonly deps: ClassicTransportDeps;
  private readonly token: string;
  private readonly currentUser: ClassicTransportOptions['currentUser'];
  private summary: ConversationSummary;
  private messages: Message[] = [];
  private receipts: Record<string, MessageReceipt[]> = {};
  private queued: OutboxItem[] = [];
  private handlers: ChatTransportHandlers | null = null;
  private cleanups: (() => void)[] = [];

  constructor(deps: ClassicTransportDeps, options: ClassicTransportOptions) {
    if (options.summary.e2eeSince) {
      throw new EncryptedConversationError(options.conversationId);
    }
    this.deps = deps;
    this.conversationId = options.conversationId;
    this.token = options.token;
    this.currentUser = options.currentUser;
    this.summary = options.summary;
  }

  async loadInitial(): Promise<ChatSnapshot> {
    const [summary, history, receipts, queued] = await Promise.all([
      this.deps.api.getConversation(this.token, this.conversationId),
      this.deps.api.listMessages(this.token, this.conversationId, { limit: PAGE_SIZE }),
      this.deps.api.listReceipts(this.token, this.conversationId),
      this.deps.outbox.listOutbox(this.conversationId),
    ]);
    this.summary = summary;
    this.messages = history;
    this.receipts = groupReceipts(receipts);
    this.queued = queued;
    this.deps.cache.setConversation(summary);
    this.deps.cache.setMessages(this.conversationId, history);
    void this.deps.sync.advanceCursor(history);
    // Même déclencheur que l'ancien écran : la lecture est signalée une fois
    // l'historique chargé, jamais avant.
    this.deps.socket.getSocket()?.emit('message:read', { conversationId: this.conversationId });
    return {
      messages: this.views(),
      receipts: this.receipts,
      hasMore: history.length >= PAGE_SIZE,
      unreadCount: summary.unreadCount,
    };
  }

  async loadOlder(beforeCreatedAt: string): Promise<ChatPage> {
    const older = await this.deps.api.listMessages(this.token, this.conversationId, {
      before: beforeCreatedAt,
      limit: PAGE_SIZE,
    });
    this.messages = mergeMessages(this.messages, older);
    this.deps.cache.setMessages(this.conversationId, this.messages);
    return {
      messages: older.map((message) => this.viewOf(message)),
      hasMore: older.length >= PAGE_SIZE,
    };
  }

  subscribe(handlers: ChatTransportHandlers): () => void {
    this.unsubscribe();
    this.handlers = handlers;
    const socket = this.deps.socket.connectSocket(this.token);

    const join = () => {
      socket.emit('conversation:join', { conversationId: this.conversationId });
      socket.emit('conversation:focus', { conversationId: this.conversationId });
    };
    const onMessage = (message: Message) => this.ingest([message]);
    const onDeleted = (payload: DeletedPayload) => {
      if (payload?.conversationId !== this.conversationId || !payload.messageId) return;
      const removed = payload.messageId;
      this.messages = payload.forEveryone
        ? this.messages.map((message) =>
            message.id === removed
              ? { ...message, deleted: true, content: '', attachment: null }
              : message,
          )
        : this.messages.filter((message) => message.id !== removed);
      this.deps.cache.setMessages(this.conversationId, this.messages);
      this.handlers?.onMessageRemoved(removed, Boolean(payload.forEveryone));
    };
    const onReceipt = (payload: ReceiptPayload) => {
      if (!Array.isArray(payload?.receipts)) return;
      for (const receipt of payload.receipts) {
        const list = (this.receipts[receipt.messageId] ?? []).filter(
          (existing) => existing.userId !== receipt.userId,
        );
        list.push(receipt);
        this.receipts[receipt.messageId] = list;
      }
      this.handlers?.onReceipts(payload.receipts);
    };
    const onReaction = (payload: ReactionPayload) => {
      if (payload?.conversationId !== this.conversationId) return;
      this.messages = this.messages.map((message) =>
        message.id === payload.messageId ? { ...message, reactions: payload.reactions } : message,
      );
      this.deps.cache.setMessages(this.conversationId, this.messages);
      this.handlers?.onReaction(payload.messageId, payload.reactions);
    };
    const onTyping = (payload: TypingPayload) => {
      if (payload.conversationId !== this.conversationId || payload.userId === this.currentUser.id) {
        return;
      }
      this.handlers?.onTyping(
        payload.typing === false
          ? null
          : { userId: payload.userId, text: payload.text ?? '' },
      );
    };
    const onGroupUpdated = (event: GroupEvent) => {
      if (event.conversationId !== this.conversationId) return;
      this.summary = {
        ...this.summary,
        name: event.group.name,
        description: event.group.description,
        emoji: event.group.emoji,
        color: event.group.color,
        avatarUrl: event.group.avatarUrl,
        ownerId: event.group.ownerId,
        whoCanSend: event.group.whoCanSend,
        whoCanAdd: event.group.whoCanAdd,
        members: event.members,
        updatedAt: event.group.updatedAt,
      };
      this.deps.cache.setConversation(this.summary);
      this.handlers?.onConversationUpdated(this.summary);
    };
    const onRemoved = (event: { conversationId: string }) => {
      if (event.conversationId === this.conversationId) {
        this.handlers?.onConversationRemoved();
      }
    };

    socket.on('message:new', onMessage);
    socket.on('message:deleted', onDeleted);
    socket.on('receipt', onReceipt);
    socket.on('message:reaction', onReaction);
    socket.on('typing', onTyping);
    socket.on('group:updated', onGroupUpdated);
    socket.on('members:changed', onGroupUpdated);
    socket.on('conversation:removed', onRemoved);
    if (socket.connected) {
      join();
    } else {
      socket.on('connect', join);
    }
    this.cleanups.push(() => {
      socket.off('message:new', onMessage);
      socket.off('message:deleted', onDeleted);
      socket.off('receipt', onReceipt);
      socket.off('message:reaction', onReaction);
      socket.off('typing', onTyping);
      socket.off('group:updated', onGroupUpdated);
      socket.off('members:changed', onGroupUpdated);
      socket.off('conversation:removed', onRemoved);
      socket.off('connect', join);
    });

    const offMissed = this.deps.sync.onMissedMessages((messages) => this.ingest(messages));
    const offSent = this.deps.outbox.onSent((message) => this.ingest([message]));
    const offConnection = this.deps.socket.onConnection((online) =>
      this.handlers?.onConnection(online),
    );
    const offOutbox = this.deps.outbox.subscribe(() => {
      void this.refreshQueued();
    });
    this.cleanups.push(offMissed, offSent, offConnection, offOutbox);
    void this.refreshQueued();
    return () => this.unsubscribe();
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
  }

  async sendText(text: string, replyToId: string | null): Promise<void> {
    if (!this.capabilities.replies && replyToId) {
      throw new UnsupportedCapabilityError('replies');
    }
    const content = text.trim();
    if (!content) return;
    await this.deps.outbox.enqueue({
      conversationId: this.conversationId,
      content,
      replyTo: replyToId,
    });
    await this.deps.outbox.drain(this.token);
  }

  async sendMedia(
    asset: OutgoingAsset,
    caption: string,
    replyToId: string | null,
  ): Promise<void> {
    await this.deps.outbox.enqueue({
      conversationId: this.conversationId,
      content: caption,
      replyTo: replyToId,
      attachment: {
        localUri: asset.uri,
        kind: asset.kind,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs,
        name: asset.name,
        size: asset.size,
      },
    });
    await this.deps.outbox.drain(this.token);
  }

  async sendSticker(ref: string): Promise<void> {
    if (!this.capabilities.stickers) {
      throw new UnsupportedCapabilityError('stickers');
    }
    await this.deps.outbox.enqueue({
      conversationId: this.conversationId,
      type: 'sticker',
      stickerRef: ref,
      content: '',
    });
    await this.deps.outbox.drain(this.token);
  }

  async sendPersonalSticker(sticker: PersonalSticker): Promise<void> {
    if (!this.capabilities.stickers) {
      throw new UnsupportedCapabilityError('stickers');
    }
    await this.deps.outbox.enqueue({
      conversationId: this.conversationId,
      content: '',
      attachment: {
        localUri: sticker.uri,
        kind: 'sticker',
        mime: sticker.mime,
        width: sticker.width,
        height: sticker.height,
        name: sticker.name,
        size: sticker.size ?? null,
        external: {
          id: sticker.id,
          packId: PERSONAL_STICKER_PACK_ID,
          name: sticker.name,
          width: sticker.width,
          height: sticker.height,
        },
      },
    });
    await this.deps.outbox.drain(this.token);
  }

  async sendGif(gif: RecentGif): Promise<void> {
    if (!this.capabilities.gifs) {
      throw new UnsupportedCapabilityError('gifs');
    }
    await this.deps.outbox.enqueue({
      conversationId: this.conversationId,
      content: '',
      attachment: {
        kind: 'gif',
        mime: gif.sticker ? 'image/webp' : 'image/gif',
        width: gif.width ?? null,
        height: gif.height ?? null,
        external: {
          url: gif.url,
          width: gif.width,
          height: gif.height,
          sticker: gif.sticker,
          giphyId: gif.giphyId,
          username: gif.username,
          title: gif.title,
          stillUrl: gif.stillUrl,
        },
      },
    });
    await this.deps.outbox.drain(this.token);
  }

  async sendVoice(note: VoiceNote): Promise<void> {
    if (!this.capabilities.voice) {
      throw new UnsupportedCapabilityError('voice');
    }
    await this.deps.outbox.enqueue({
      conversationId: this.conversationId,
      content: '',
      attachment: {
        localUri: note.uri,
        mime: note.mimeType,
        durationMs: note.durationMs,
        kind: 'audio',
      },
    });
    await this.deps.outbox.drain(this.token);
  }

  async forwardText(): Promise<void> {
    throw new UnsupportedCapabilityError('forwarded');
  }

  async deleteMessage(id: string, forEveryone: boolean): Promise<void> {
    if (forEveryone && !this.capabilities.deleteForEveryone) {
      throw new UnsupportedCapabilityError('deleteForEveryone');
    }
    const waiting = this.queued.some((item) => item.clientId === id);
    if (waiting) {
      await this.deps.outbox.discard(id);
      await this.refreshQueued();
      return;
    }
    await this.deps.socket.deleteMessage(this.token, this.conversationId, id, forEveryone);
    if (!forEveryone) {
      this.messages = this.messages.filter((message) => message.id !== id);
      this.deps.cache.setMessages(this.conversationId, this.messages);
      this.handlers?.onMessageRemoved(id, false);
    }
  }

  async toggleReaction(id: string, reaction: string): Promise<void> {
    if (!this.capabilities.reactions) {
      throw new UnsupportedCapabilityError('reactions');
    }
    const reactions = await this.deps.socket.toggleReaction(
      this.token,
      this.conversationId,
      id,
      reaction,
    );
    this.messages = this.messages.map((message) =>
      message.id === id ? { ...message, reactions } : message,
    );
    this.deps.cache.setMessages(this.conversationId, this.messages);
    this.handlers?.onReaction(id, reactions);
  }

  async markRead(): Promise<void> {
    this.deps.socket.getSocket()?.emit('message:read', { conversationId: this.conversationId });
  }

  reportDelivered(ids: string[]): void {
    this.deps.socket.reportDelivered(ids);
  }

  setTyping(active: boolean, text?: string): void {
    if (!this.capabilities.typing) {
      throw new UnsupportedCapabilityError('typing');
    }
    this.deps.socket.getSocket()?.emit('typing', {
      conversationId: this.conversationId,
      typing: active,
      ...(text ? { text: text.slice(0, 300) } : {}),
    });
  }

  saveDraft(text: string): void {
    if (text.trim()) {
      this.deps.cache.setDraft(this.conversationId, text);
    } else {
      this.deps.cache.clearDraft(this.conversationId);
    }
  }

  async loadDraft(): Promise<string> {
    return this.deps.cache.getDraft(this.conversationId);
  }

  retry(id: string): void {
    void this.deps.outbox.retry(id).then(() => this.deps.outbox.drain(this.token));
  }

  async discard(id: string): Promise<void> {
    await this.deps.outbox.discard(id);
    await this.refreshQueued();
  }

  private viewOf(message: Message): ChatMessageView {
    const mine = message.sender.id === this.currentUser.id;
    return classicMessageToView(message, {
      currentUserId: this.currentUser.id,
      state: mine ? tickState(this.receipts[message.id] ?? []) : 'none',
    });
  }

  private views(): ChatMessageView[] {
    const confirmed = new Set(
      this.messages
        .map((message) => message.clientId)
        .filter((clientId): clientId is string => Boolean(clientId)),
    );
    const views = this.messages.map((message) => this.viewOf(message));
    for (const item of this.queued) {
      if (confirmed.has(item.clientId)) continue;
      const pending = this.deps.outbox.pendingMessage(
        item,
        this.currentUser,
        (quoteId) => {
          const origin = this.messages.find((message) => message.id === quoteId);
          return origin ? quoteOfMessage(origin) : null;
        },
      );
      const failed =
        item.status === 'failed' ||
        (item.kind !== 'audio' && item.status === 'pending' && item.error !== null);
      views.push(
        classicMessageToView(pending, {
          currentUserId: this.currentUser.id,
          state: failed ? 'failed' : 'pending',
          error: item.error,
          progress: item.progress,
        }),
      );
    }
    views.sort((a, b) => this.orderAt(a) - this.orderAt(b));
    return views;
  }

  private orderAt(view: ChatMessageView): number {
    return (
      this.deps.outbox.localCreatedAtMs(view.clientId) ?? new Date(view.createdAt).getTime()
    );
  }

  private ingest(incoming: Message[]): void {
    if (incoming.length === 0) return;
    const before = this.messages;
    const next = mergeMessages(before, incoming);
    if (next === before) return;
    this.messages = next;
    this.deps.cache.setMessages(this.conversationId, next);
    void this.deps.sync.advanceCursor(incoming);
    const foreign = incoming.filter((message) => message.sender.id !== this.currentUser.id);
    if (foreign.length > 0) {
      this.deps.socket.reportDelivered(foreign.map((message) => message.id));
      this.deps.socket.getSocket()?.emit('message:read', { conversationId: this.conversationId });
    }
    for (const message of incoming) {
      if (before.some((known) => known.id === message.id)) continue;
      this.handlers?.onMessage(this.viewOf(message));
    }
  }

  private async refreshQueued(): Promise<void> {
    const previous = this.queued;
    const queued = await this.deps.outbox.listOutbox(this.conversationId);
    this.queued = queued;
    const current = new Set(queued.map((item) => item.clientId));
    for (const item of previous) {
      if (!current.has(item.clientId)) {
        this.handlers?.onMessageRemoved(item.clientId, false);
      }
    }
    for (const view of this.views()) {
      if (view.state === 'pending' || view.state === 'failed') {
        this.handlers?.onMessage(view);
      }
    }
  }

  private unsubscribe(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.handlers = null;
  }
}
