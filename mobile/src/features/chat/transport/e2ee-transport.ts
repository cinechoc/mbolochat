import type { E2eeAccountRow, E2eeDatabase, StoredE2eeMessage } from '@/features/e2ee/db';
import type { RecentGif } from '@/features/media/GifPanel';
import type { PersonalSticker } from '@/features/stickers/stickerLibrary';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import { isReactionRef } from '@/features/stickers/reactionRules';
import type { Message, MessageReceipt, ReactionSummary } from '@/lib/types';
import { MessageIndex } from '../model/message-index';
import { storedMessageToView } from '../model/message-view';
import type { E2eeTransportDeps, E2eeTransportOptions } from './deps';
import {
  PlaintextConversationError,
  UnsupportedCapabilityError,
  type ChatCapabilities,
  type ChatMessageView,
  type ChatPage,
  type ChatSnapshot,
  type ChatTransport,
  type ChatTransportHandlers,
  type OutgoingAsset,
} from './types';

const LOCAL_PAGE_SIZE = 50;
const TYPING_REFRESH_MS = 2_500;
const TYPING_EXPIRY_MS = 4_000;

const E2EE_CAPABILITIES: ChatCapabilities = {
  replies: true,
  reactions: true,
  deleteForEveryone: true,
  stickers: true,
  gifs: false,
  forwarded: true,
  voice: true,
  typing: true,
  calls: false,
  albums: false,
  groups: false,
  encrypted: true,
  pagination: 'local',
  receipts: 'delivered-opened',
};

interface ReceiptPayload {
  receipts?: MessageReceipt[];
}

/**
 * Transport de la conversation chiffrée de bout en bout.
 *
 * Le serveur reste aveugle : il ne fournit que des métadonnées et des
 * enveloppes. Les fonctions crypto existantes sont **appelées via les
 * dépendances injectées**, jamais modifiées, et aucun accès à l'outbox ni à un
 * upload en clair n'existe dans cette classe.
 */
export class E2eeTransport implements ChatTransport {
  readonly mode = 'e2ee' as const;
  readonly capabilities = E2EE_CAPABILITIES;
  readonly conversationId: string;

  private readonly deps: E2eeTransportDeps;
  private readonly token: string;
  private readonly currentUser: E2eeTransportOptions['currentUser'];
  private readonly peer: E2eeTransportOptions['peer'];
  private readonly summary: E2eeTransportOptions['summary'];
  private readonly isForeground: E2eeTransportOptions['isForeground'];
  private readonly isPeerOnline: E2eeTransportOptions['isPeerOnline'];

  private db: E2eeDatabase['db'] | null = null;
  private account: E2eeAccountRow | null = null;
  private index = new MessageIndex<ChatMessageView>();
  private readonly stored = new Map<string, StoredE2eeMessage>();
  private receipts: Record<string, MessageReceipt[]> = {};
  private reactions = new Map<string, ReactionSummary[]>();
  private handlers: ChatTransportHandlers | null = null;
  private cleanups: (() => void)[] = [];
  private ready = false;
  private pendingAcks: string[] = [];
  private decryptChain: Promise<unknown> = Promise.resolve();
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTypingSentAt = Number.NEGATIVE_INFINITY;
  private lastTypingState: boolean | null = null;

  constructor(deps: E2eeTransportDeps, options: E2eeTransportOptions) {
    if (!options.summary.e2eeSince) {
      throw new PlaintextConversationError(options.conversationId);
    }
    if (options.summary.type !== 'DIRECT') {
      throw new Error('Conversation de groupe : le transport E2EE est refusé');
    }
    this.deps = deps;
    this.conversationId = options.conversationId;
    this.token = options.token;
    this.currentUser = options.currentUser;
    this.peer = options.peer;
    this.summary = options.summary;
    this.isForeground = options.isForeground;
    this.isPeerOnline = options.isPeerOnline;
  }

  async loadInitial(): Promise<ChatSnapshot> {
    const { db } = await this.credentials();
    const local = await this.deps.db.listLocalMessages(db, this.conversationId);
    this.reactions = await this.deps.db.loadReactionSummaries(
      db,
      this.conversationId,
      this.currentUser.id,
    );
    for (const stored of local) {
      this.absorb(stored, false);
    }
    const knownReceipts = await this.deps.api
      .listReceipts(this.token, this.conversationId)
      .catch(() => [] as MessageReceipt[]);
    this.receipts = this.deps.receipts.mergeReceipts(this.receipts, knownReceipts);
    // Les messages locaux ont été absorbés avant l'arrivée des accusés : il
    // faut recalculer leur état pour afficher « Reçu » ou « Ouvert » dès le
    // chargement, sans attendre un nouvel événement socket.
    for (const stored of this.stored.values()) {
      this.render(stored);
    }

    // Le serveur peut être indisponible alors que SQLCipher contient déjà
    // l'historique. Dans ce cas on rend le snapshot local au lieu de perdre
    // l'écran ; la reconnexion socket apportera les messages manquants.
    let history: Message[] = [];
    try {
      history = await this.deps.api.listMessages(this.token, this.conversationId, {
        limit: 50,
      });
    } catch {
      history = [];
    }
    const known = await this.deps.db.knownMessageKeys(db, this.conversationId);
    for (const message of history) {
      if (message.encryption !== 'v1') continue;
      if (known.ids.has(message.id)) continue;
      if (message.clientId && known.clientIds.has(message.clientId)) continue;
      await this.queueDecrypt(message);
    }
    this.ready = true;
    this.flushAcks();
    const oldest = this.oldestVisible();
    const probe = oldest
      ? await this.deps.db.listLocalMessagesBefore(
          db,
          this.conversationId,
          oldest.created_at,
          oldest.id,
          1,
        )
      : [];
    return {
      messages: [...this.index.values()],
      receipts: this.receipts,
      hasMore: probe.length > 0,
      unreadCount: 0,
    };
  }

  async loadOlder(beforeCreatedAt: string, beforeId?: string): Promise<ChatPage> {
    const { db } = await this.credentials();
    const cursor =
      (beforeId ? this.stored.get(beforeId) : undefined) ??
      this.oldestVisible(beforeCreatedAt);
    if (!cursor) return { messages: [], hasMore: false };
    const rows = await this.deps.db.listLocalMessagesBefore(
      db,
      this.conversationId,
      cursor.created_at,
      cursor.id,
      LOCAL_PAGE_SIZE + 1,
    );
    const page = rows.slice(0, LOCAL_PAGE_SIZE);
    const views = page.map((stored) => this.absorb(stored, false));
    return { messages: views, hasMore: rows.length > LOCAL_PAGE_SIZE };
  }

  async loadDraft(): Promise<string> {
    const { db } = await this.credentials();
    return this.deps.db.loadDraft(db, this.conversationId);
  }

  subscribe(handlers: ChatTransportHandlers): () => void {
    this.unsubscribe();
    this.handlers = handlers;
    const socket = this.deps.socket.connectSocket(this.token);
    const onMessage = (message: Message) => {
      if (
        message.conversationId !== this.conversationId ||
        message.sender.id === this.currentUser.id ||
        message.encryption !== 'v1'
      ) {
        return;
      }
      void this.queueDecrypt(message);
    };
    const onReceipt = (payload: ReceiptPayload) => {
      if (!Array.isArray(payload?.receipts) || payload.receipts.length === 0) return;
      this.receipts = this.deps.receipts.mergeReceipts(this.receipts, payload.receipts);
      // L'accusé modifie l'état de la bulle elle-même : `onReceipts` ne sert
      // qu'aux compteurs « Vu par ». Sans cet upsert, une coche « Reçu » ou
      // « Ouvert » n'apparaîtrait qu'après un rechargement complet.
      const refreshed = new Set<string>();
      for (const receipt of payload.receipts) {
        if (typeof receipt?.messageId !== 'string' || refreshed.has(receipt.messageId)) {
          continue;
        }
        refreshed.add(receipt.messageId);
        const stored = this.stored.get(receipt.messageId);
        if (stored) {
          this.handlers?.onMessage(this.render(stored));
        }
      }
      this.handlers?.onReceipts(payload.receipts);
    };
    const onTyping = (payload: { conversationId?: string; userId?: string; typing?: boolean }) => {
      if (
        payload?.conversationId !== this.conversationId ||
        !payload.userId ||
        payload.userId === this.currentUser.id
      ) {
        return;
      }
      if (this.typingTimer) {
        clearTimeout(this.typingTimer);
        this.typingTimer = null;
      }
      if (payload.typing === false) {
        this.handlers?.onTyping(null);
        return;
      }
      this.handlers?.onTyping({ userId: payload.userId, text: '' });
      this.typingTimer = setTimeout(() => {
        this.typingTimer = null;
        this.handlers?.onTyping(null);
      }, TYPING_EXPIRY_MS);
    };
    socket.on('message:new', onMessage);
    socket.on('receipt', onReceipt);
    socket.on('typing', onTyping);
    const offConnection = this.deps.socket.onConnection((online) =>
      this.handlers?.onConnection(online),
    );
    void this.deps.socket.ensureSocket(this.token).catch(() => undefined);
    this.cleanups.push(() => {
      socket.off('message:new', onMessage);
      socket.off('receipt', onReceipt);
      socket.off('typing', onTyping);
      offConnection();
    });
    return () => this.unsubscribe();
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    const db = this.db;
    this.db = null;
    this.account = null;
    await db?.closeAsync().catch(() => undefined);
  }

  async sendText(text: string, replyToId: string | null): Promise<void> {
    if (!this.capabilities.replies) {
      throw new UnsupportedCapabilityError('replies');
    }
    const { db, account } = await this.credentials();
    const result = await this.deps.crypto.sendEncryptedText({
      token: this.token,
      db,
      account,
      conversation: this.summary,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      text,
      replyToId,
    });
    this.absorb(result.stored, true);
    void this.deps.db.saveDraft(db, this.conversationId, '').catch(() => undefined);
  }

  async sendMedia(
    asset: OutgoingAsset,
    caption: string,
    replyToId: string | null,
  ): Promise<void> {
    const { db, account } = await this.credentials();
    const result = await this.deps.crypto.sendEncryptedMedia({
      token: this.token,
      db,
      account,
      conversation: this.summary,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      asset: {
        uri: asset.uri,
        kind: asset.kind,
        mime: asset.mime ?? 'application/octet-stream',
        name: asset.name ?? '',
        size: asset.size,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        durationMs: asset.durationMs ?? undefined,
        waveform: asset.waveform,
      },
      caption,
      replyToId,
    });
    this.absorb(result.stored, true);
  }

  async sendVoice(note: VoiceNote): Promise<void> {
    if (!this.capabilities.voice) {
      throw new UnsupportedCapabilityError('voice');
    }
    await this.sendMedia(
      {
        uri: note.uri,
        kind: 'audio',
        mime: note.mimeType,
        name: null,
        size: null,
        width: null,
        height: null,
        durationMs: note.durationMs,
        waveform: note.waveform,
      },
      '',
      null,
    );
  }

  async sendSticker(ref: string): Promise<void> {
    if (!this.capabilities.stickers) {
      throw new UnsupportedCapabilityError('stickers');
    }
    const { db, account } = await this.credentials();
    const result = await this.deps.crypto.sendEncryptedSticker({
      token: this.token,
      db,
      account,
      conversation: this.summary,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      stickerRef: ref,
    });
    this.absorb(result.stored, true);
  }

  async sendPersonalSticker(_sticker: PersonalSticker): Promise<void> {
    throw new UnsupportedCapabilityError('stickers');
  }

  async sendGif(_gif: RecentGif): Promise<void> {
    throw new UnsupportedCapabilityError('gifs');
  }

  async forwardText(
    target: E2eeTransportOptions['summary'],
    text: string,
  ): Promise<void> {
    if (!this.capabilities.forwarded) {
      throw new UnsupportedCapabilityError('forwarded');
    }
    if (!target.e2eeSince || target.type !== 'DIRECT') {
      throw new Error('Transfert refusé : la cible doit être une conversation chiffrée directe.');
    }
    const { db, account } = await this.credentials();
    const result = await this.deps.crypto.sendEncryptedText({
      token: this.token,
      db,
      account,
      conversation: target,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      text,
    });
    this.deps.cache.patchConversation({
      ...target,
      lastMessage: result.serverMessage,
      updatedAt: result.serverMessage.createdAt,
    });
  }

  async deleteMessage(id: string, forEveryone: boolean): Promise<void> {
    if (forEveryone) {
      const target = this.stored.get(id);
      if (
        !target ||
        target.mine !== 1 ||
        target.id === target.client_id ||
        target.deleted === 1 ||
        target.hidden === 1
      ) {
        return;
      }
      const { db, account } = await this.credentials();
      await this.deps.crypto.sendEncryptedDelete({
        token: this.token,
        db,
        account,
        conversation: this.summary,
        currentUserId: this.currentUser.id,
        currentUserName: this.currentUser.displayName,
        targetId: id,
      });
      const result = await this.deps.deletion.applyDeleteForAll(
        this.db ?? db,
        id,
        this.currentUser.id,
        this.conversationId,
      );
      await this.deps.deletion.cleanupDeletedMedia(this.db ?? db, result.refs);
      if (result.applied) {
        const deleted: StoredE2eeMessage = {
          ...target,
          body: '',
          media_meta: null,
          local_cipher_uri: null,
          upload_id: null,
          local_thumb_cipher_uri: null,
          thumb_upload_id: null,
          sticker_ref: null,
          quote_id: null,
          unreadable_reason: null,
          raw_payload: null,
          deleted: 1,
          deleted_by: this.currentUser.id,
        };
        this.stored.set(id, deleted);
        this.reactions.delete(id);
        this.index.upsert(this.render(deleted));
      }
      this.handlers?.onMessageRemoved(id, true);
      return;
    }
    const { db } = await this.credentials();
    this.stored.delete(id);
    this.index.remove(id);
    await this.deps.db.deleteLocalMessage(db, id).catch(() => undefined);
    this.handlers?.onMessageRemoved(id, false);
    await this.deps.socket.deleteMessage(this.token, this.conversationId, id, false);
  }

  async toggleReaction(id: string, reaction: string): Promise<void> {
    if (!this.capabilities.reactions) {
      throw new UnsupportedCapabilityError('reactions');
    }
    const target = this.stored.get(id);
    if (
      !target ||
      target.id === target.client_id ||
      target.deleted === 1 ||
      target.hidden === 1
    ) {
      return;
    }
    if (!isReactionRef(reaction)) return;
    const active = this.reactions.get(id) ?? [];
    const mine = active.some((entry) => entry.reaction === reaction && entry.mine);
    const { db, account } = await this.credentials();
    await this.deps.crypto.sendEncryptedReaction({
      token: this.token,
      db,
      account,
      conversation: this.summary,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      targetId: id,
      reaction,
      action: mine ? 'remove' : 'add',
    });
    this.reactions = await this.deps.db.loadReactionSummaries(
      db,
      this.conversationId,
      this.currentUser.id,
    );
    this.handlers?.onReaction(id, this.reactions.get(id) ?? []);
  }

  async markRead(ids?: string[]): Promise<void> {
    if (!ids || ids.length === 0) return;
    await this.deps.api.markMessagesRead(this.token, this.conversationId, ids);
  }

  reportDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    if (
      this.deps.receipts.canReportDelivered({
        appActive: this.isForeground(),
        ready: this.ready,
      })
    ) {
      this.deps.socket.reportDelivered(ids);
      return;
    }
    for (const id of ids) {
      if (!this.pendingAcks.includes(id)) this.pendingAcks.push(id);
    }
  }

  setTyping(active: boolean, _text?: string): void {
    if (!this.capabilities.typing) {
      throw new UnsupportedCapabilityError('typing');
    }
    const now = this.deps.clock();
    // Un état actif est renvoyé périodiquement pour rester visible avant
    // l'expiration côté pair ; un état déjà faux n'est jamais répété.
    if (active) {
      if (this.lastTypingState === true && now - this.lastTypingSentAt < TYPING_REFRESH_MS) {
        return;
      }
    } else if (this.lastTypingState === false) {
      return;
    }
    this.lastTypingState = active;
    this.lastTypingSentAt = now;
    this.deps.socket.ensureSocket(this.token).then((socket) => {
      socket.emit('typing', { conversationId: this.conversationId, typing: active });
    }).catch(() => undefined);
  }

  saveDraft(text: string): void {
    void this.credentials()
      .then(({ db }) => this.deps.db.saveDraft(db, this.conversationId, text))
      .catch(() => undefined);
  }

  retry(): void {
    throw new Error('La reprise chiffrée n’est pas disponible dans ce mode.');
  }

  async discard(): Promise<void> {
    // Aucun message chiffré n'attend dans une file locale : rien à jeter.
  }

  private async credentials(): Promise<{
    db: E2eeDatabase['db'];
    account: E2eeAccountRow;
  }> {
    if (!this.db) {
      const opened = await this.deps.db.openE2eeDatabase();
      this.db = opened.db;
    }
    if (!this.account) {
      const account = await this.deps.db.loadE2eeAccount(this.db);
      if (!account) {
        throw new Error('Clés de l’appareil indisponibles.');
      }
      this.account = account;
    }
    return { db: this.db, account: this.account };
  }

  private absorb(stored: StoredE2eeMessage, emit: boolean): ChatMessageView {
    const existed = this.stored.has(stored.id);
    this.stored.set(stored.id, stored);
    if (stored.hidden === 1) {
      return storedMessageToView(stored, {
        currentUser: this.currentUser,
        peer: this.peer,
        state: 'none',
      });
    }
    const view = this.render(stored);
    if (emit && !existed) {
      this.handlers?.onMessage(view);
    }
    return view;
  }

  /** Recalcule la vue d'un message déjà connu, sans le signaler comme nouveau. */
  private render(stored: StoredE2eeMessage): ChatMessageView {
    const view = storedMessageToView(stored, {
      currentUser: this.currentUser,
      peer: this.peer,
      state: this.deliveryOf(stored),
      reactions: this.reactions.get(stored.id) ?? [],
    });
    this.index.upsert(view);
    return view;
  }

  private oldestVisible(atOrBefore?: string): StoredE2eeMessage | null {
    let oldest: StoredE2eeMessage | null = null;
    for (const stored of this.stored.values()) {
      if (stored.hidden === 1) continue;
      if (atOrBefore && stored.created_at > atOrBefore) continue;
      if (
        !oldest ||
        stored.created_at < oldest.created_at ||
        (stored.created_at === oldest.created_at && (stored.rowid ?? 0) < (oldest.rowid ?? 0))
      ) {
        oldest = stored;
      }
    }
    return oldest;
  }

  private deliveryOf(stored: StoredE2eeMessage): ChatMessageView['state'] {
    if (stored.mine !== 1) return 'none';
    const state = this.deps.receipts.receiptState(
      this.receipts[stored.id],
      this.currentUser.id,
      this.isPeerOnline(),
    );
    if (state === 'read') return 'read';
    if (state === 'delivered') return 'delivered';
    return 'sent';
  }

  private queueDecrypt(message: Message): Promise<unknown> {
    this.decryptChain = this.decryptChain.then(async () => {
      const { db, account } = await this.credentials();
      try {
        const result = await this.deps.crypto.decryptIncoming({
          token: this.token,
          db,
          account,
          message,
          currentUserId: this.currentUser.id,
        });
        if (result.reactionEvent) {
          this.reactions = await this.deps.db.loadReactionSummaries(
            db,
            this.conversationId,
            this.currentUser.id,
          );
          const target = this.stored.get(result.reactionEvent.targetId);
          if (target) {
            this.handlers?.onReaction(
              target.id,
              this.reactions.get(target.id) ?? [],
            );
          }
        } else if (result.deletionEvent) {
          const targetId = result.deletionEvent.targetId;
          const target = result.deletionEvent.target ?? this.stored.get(targetId);
          if (target) {
            this.stored.set(targetId, target);
            this.reactions.delete(targetId);
            this.index.upsert(this.render(target));
          }
          if (result.deletionEvent.applied) {
            this.handlers?.onMessageRemoved(targetId, true);
          }
        } else {
          this.absorb(result.stored, true);
        }
        const deletedRefs = result.deletionEvent?.mediaRefs ?? result.deletedMediaRefs;
        if (deletedRefs) {
          await this.deps.deletion.cleanupDeletedMedia(db, deletedRefs);
        }
        const acked = this.deps.receipts.deliveredIds([result.stored]);
        if (acked.length > 0) this.reportDelivered(acked);
      } catch {
        // Un message illisible est déjà persisté avec son motif par le noyau :
        // l'écran affiche le libellé normalisé, jamais l'exception.
      }
    });
    return this.decryptChain;
  }

  private flushAcks(): void {
    if (this.pendingAcks.length === 0) return;
    if (
      !this.deps.receipts.canReportDelivered({
        appActive: this.isForeground(),
        ready: this.ready,
      })
    ) {
      return;
    }
    const ids = this.pendingAcks.splice(0);
    this.deps.socket.reportDelivered(ids);
  }

  private unsubscribe(): void {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.handlers = null;
  }
}
