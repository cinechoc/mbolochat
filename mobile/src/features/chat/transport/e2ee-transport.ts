import type { E2eeAccountRow, E2eeDatabase, StoredE2eeMessage } from '@/features/e2ee/db';
import type { RecentGif } from '@/features/media/GifPanel';
import type { PersonalSticker } from '@/features/stickers/stickerLibrary';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import { isReactionRef } from '@/features/stickers/reactionRules';
import { isEphemeralTtl } from '@/features/e2ee/payload';
import type { Message, MessageReceipt, ReactionSummary } from '@/lib/types';
import { MessageIndex } from '../model/message-index';
import { isOwnStoredMessage, storedMessageToView } from '../model/message-view';
import { normalizedSendOptions, type TextSendOptions } from '../model/send-options';
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
const EXPIRY_SWEEP_MS = 30_000;

function newClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const E2EE_CAPABILITIES: ChatCapabilities = {
  replies: true,
  reactions: true,
  deleteForEveryone: true,
  stickers: true,
  gifs: false,
  forwarded: true,
  voice: true,
  typing: true,
  edit: true,
  ephemeral: true,
  calls: false,
  albums: false,
  groups: false,
  encrypted: true,
  pagination: 'local',
  receipts: 'delivered-opened',
  sendOptions: true,
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
  private readonly pendingReads = new Set<string>();
  private readChain: Promise<void> = Promise.resolve();
  private decryptChain: Promise<unknown> = Promise.resolve();
  private readonly queuedDecrypts = new Set<string>();
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
    this.deps.scheduled.wakeScheduledQueue();
    await this.sweepExpired();
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
    const ephemeral = await this.deps.db.loadConversationEphemeral(db, this.conversationId);
    return {
      messages: [...this.index.values()],
      receipts: this.receipts,
      hasMore: probe.length > 0,
      unreadCount: 0,
      ephemeralSeconds: ephemeral?.ephemeral_ttl_seconds ?? 0,
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
    const onMissed = (messages: Message[]) => {
      for (const message of messages) {
        if (
          message.conversationId !== this.conversationId ||
          message.sender.id === this.currentUser.id ||
          message.encryption !== 'v1'
        ) {
          continue;
        }
        void this.queueDecrypt(message);
      }
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
    const offMissed = this.deps.sync.onMissedMessages(onMissed);
    const offConnection = this.deps.socket.onConnection((online) => {
      this.handlers?.onConnection(online);
      if (online) void this.flushReads();
    });
    void this.sweepExpired();
    const expiryTimer = setInterval(() => {
      void this.sweepExpired();
    }, EXPIRY_SWEEP_MS);
    void this.deps.socket.ensureSocket(this.token).catch(() => undefined);
    this.cleanups.push(() => {
      socket.off('message:new', onMessage);
      socket.off('receipt', onReceipt);
      socket.off('typing', onTyping);
      offMissed();
      offConnection();
      clearInterval(expiryTimer);
    });
    this.cleanups.push(
      this.deps.scheduled.onScheduledEvent((event) => {
        if (event.conversationId !== this.conversationId) return;
        const existed = this.stored.has(event.previousId);
        if (event.type === 'sent' && event.previousId !== event.stored.id) {
          this.stored.delete(event.previousId);
          this.index.remove(event.previousId);
          if (existed) this.handlers?.onMessageRemoved(event.previousId, false);
        }
        this.absorb(event.stored, true);
        if (event.type === 'failed' && existed) {
          this.handlers?.onMessage(this.render(event.stored));
        }
      }),
    );
    this.cleanups.push(
      this.deps.outboxRecovery.onE2eeOutboxEvent((event) => {
        if (event.conversationId !== this.conversationId) return;
        const existed = this.stored.has(event.previousId);
        if (event.type === 'sent' && event.stored) {
          if (event.stored.id !== event.previousId) {
            this.stored.delete(event.previousId);
            this.index.remove(event.previousId);
            if (existed) this.handlers?.onMessageRemoved(event.previousId, false);
          }
          this.absorb(event.stored, true);
          return;
        }
        if (event.type === 'failed' && event.stored) {
          this.stored.set(event.previousId, event.stored);
          this.handlers?.onMessage(this.render(event.stored));
        }
      }),
    );
    this.deps.outboxRecovery.wakeE2eeOutboxRecovery();
    return () => this.unsubscribe();
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    const db = this.db;
    this.db = null;
    this.account = null;
    await db?.closeAsync().catch(() => undefined);
  }

  async sendText(
    text: string,
    replyToId: string | null,
    options?: TextSendOptions,
  ): Promise<void> {
    if (!this.capabilities.replies) {
      throw new UnsupportedCapabilityError('replies');
    }
    const normalized = normalizedSendOptions(options);
    const preview = options?.preview ?? undefined;
    const { db, account } = await this.credentials();
    if (normalized?.scheduledAt) {
      const stored = await this.deps.scheduled.enqueueScheduledText({
        token: this.token,
        currentUserId: this.currentUser.id,
        currentUserName: this.currentUser.displayName,
        db,
        conversation: this.summary,
        text,
        replyToId,
        scheduledAt: normalized.scheduledAt,
        silent: normalized.silent,
        viewOnce: normalized.viewOnce,
        preview,
      });
      this.absorb(stored, true);
      void this.deps.db.saveDraft(db, this.conversationId, '').catch(() => undefined);
      return;
    }
    const clientId = newClientId();
    try {
      const result = await this.deps.crypto.sendEncryptedText({
        token: this.token,
        db,
        account,
        conversation: this.summary,
        currentUserId: this.currentUser.id,
        currentUserName: this.currentUser.displayName,
        text,
        replyToId,
        silent: normalized?.silent,
        viewOnce: normalized?.viewOnce,
        preview,
        clientId,
      });
      this.absorb(result.stored, true);
      void this.deps.db.saveDraft(db, this.conversationId, '').catch(() => undefined);
    } catch (cause) {
      await this.revealFailedPending(db, clientId);
      throw cause;
    }
  }

  async editMessage(id: string, text: string): Promise<void> {
    if (!this.capabilities.edit) {
      throw new UnsupportedCapabilityError('edit');
    }
    const target = this.stored.get(id);
    if (
      !target ||
      !isOwnStoredMessage(target, this.currentUser.id) ||
      target.id === target.client_id ||
      target.deleted === 1 ||
      target.hidden === 1 ||
      (target.content_kind ?? null) !== null ||
      (target.media_meta ?? null) !== null ||
      (target.sticker_ref ?? null) !== null ||
      text.trim().length === 0
    ) {
      throw new Error('edit_not_allowed');
    }
    const { db, account } = await this.credentials();
    const result = await this.deps.crypto.sendEncryptedEdit({
      token: this.token,
      db,
      account,
      conversation: this.summary,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      targetId: id,
      text,
    });
    const edited: StoredE2eeMessage = {
      ...target,
      body: text,
      edited_at: result.stored.created_at,
      edit_revision: result.revision,
    };
    this.stored.set(id, edited);
    this.index.upsert(this.render(edited));
    this.handlers?.onMessage(this.render(edited));
  }

  async sendMedia(
    asset: OutgoingAsset,
    caption: string,
    replyToId: string | null,
  ): Promise<void> {
    const { db, account } = await this.credentials();
    const clientId = newClientId();
    try {
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
          hd: asset.hd,
          viewOnce: asset.viewOnce,
        },
        caption,
        replyToId,
        clientId,
      });
      this.absorb(result.stored, true);
    } catch (cause) {
      await this.revealFailedPending(db, clientId);
      throw cause;
    }
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
        viewOnce: note.viewOnce,
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
    const clientId = newClientId();
    try {
      const result = await this.deps.crypto.sendEncryptedSticker({
        token: this.token,
        db,
        account,
        conversation: this.summary,
        currentUserId: this.currentUser.id,
        currentUserName: this.currentUser.displayName,
        stickerRef: ref,
        clientId,
      });
      this.absorb(result.stored, true);
    } catch (cause) {
      await this.revealFailedPending(db, clientId);
      throw cause;
    }
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
    const pending = this.stored.get(id);
    if (pending && pending.client_id === pending.id) {
      if (forEveryone) return;
      await this.removePendingMessage(id);
      return;
    }
    if (forEveryone) {
      const target = this.stored.get(id);
      if (
        !target ||
        !isOwnStoredMessage(target, this.currentUser.id) ||
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
          preview_json: null,
          silent: 0,
          view_once: 0,
          scheduled_at: null,
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

  async consumeViewOnce(id: string): Promise<void> {
    const { db } = await this.credentials();
    const target = this.stored.get(id);
    const pending = target !== undefined && target.client_id === target.id;
    this.stored.delete(id);
    this.index.remove(id);
    await this.deps.db.consumeLocalViewOnce(db, id, this.conversationId).catch(() => undefined);
    this.handlers?.onMessageRemoved(id, false);
    if (!pending) {
      try {
        await this.deps.socket.deleteMessage(this.token, this.conversationId, id, false);
        await this.deps.db.markViewOnceServerHidden(db, id).catch(() => undefined);
      } catch {
        // Le serveur rejouera ce masquage à la prochaine connexion : la
        // tombstone locale empêche déjà le message de réapparaître.
      }
    }
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
    for (const id of ids) this.pendingReads.add(id);
    this.readChain = this.readChain.then(() => this.flushReads());
    await this.readChain;
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

  async setEphemeral(ttlSeconds: number): Promise<void> {
    if (!this.capabilities.ephemeral) {
      throw new UnsupportedCapabilityError('ephemeral');
    }
    if (!isEphemeralTtl(ttlSeconds)) {
      throw new Error('Durée éphémère invalide');
    }
    const { db, account } = await this.credentials();
    await this.deps.crypto.sendEncryptedEphemeral({
      token: this.token,
      db,
      account,
      conversation: this.summary,
      currentUserId: this.currentUser.id,
      currentUserName: this.currentUser.displayName,
      ttlSeconds,
    });
    const state = await this.deps.db.loadConversationEphemeral(db, this.conversationId);
    this.handlers?.onEphemeral?.(state?.ephemeral_ttl_seconds ?? 0);
  }

  async getEphemeralSeconds(): Promise<number> {
    const { db } = await this.credentials();
    const state = await this.deps.db.loadConversationEphemeral(db, this.conversationId);
    return state?.ephemeral_ttl_seconds ?? 0;
  }

  private async sweepExpired(): Promise<void> {
    let db: E2eeDatabase['db'];
    try {
      ({ db } = await this.credentials());
    } catch {
      // Le balayage est opportuniste : une base momentanément indisponible ne
      // doit produire ni rejet non géré ni perte de la file de déchiffrement.
      return;
    }
    const purged = await this.deps.ephemeral.purgeExpiredMessages(db).catch(() => []);
    for (const item of purged) {
      const target = this.stored.get(item.id);
      if (target) {
        const expired: StoredE2eeMessage = {
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
          preview_json: null,
          silent: 0,
          view_once: 0,
          scheduled_at: null,
          deleted: 1,
          deleted_by: null,
        };
        this.stored.set(item.id, expired);
        this.reactions.delete(item.id);
        this.index.upsert(this.render(expired));
      }
      this.handlers?.onMessageRemoved(item.id, true);
    }
  }

  /** Rend visible une bulle dont l'envoi vient d'échouer, sans quitter SQLCipher. */
  private async revealFailedPending(
    db: E2eeDatabase['db'],
    clientId: string,
  ): Promise<void> {
    const stored = await this.deps.db
      .loadLocalMessageByClientId(db, clientId)
      .catch(() => null);
    if (!stored) return;
    this.stored.set(stored.id, stored);
    this.handlers?.onMessage(this.render(stored));
  }

  saveDraft(text: string): void {
    void this.credentials()
      .then(({ db }) => this.deps.db.saveDraft(db, this.conversationId, text))
      .catch(() => undefined);
  }

  retry(id: string): void {
    const row = this.stored.get(id);
    if (row?.scheduled_at) {
      void this.retryScheduled(id);
      return;
    }
    void this.deps.outboxRecovery.retryE2eeOutboxMessage(id, this.currentUser.id);
  }

  async discard(id: string): Promise<void> {
    const { db } = await this.credentials();
    const row = this.stored.get(id) ?? (await this.deps.db.loadLocalMessage(db, id));
    if (!row || row.client_id !== id) return;
    await this.removePendingMessage(id);
  }

  private async removePendingMessage(id: string): Promise<void> {
    const { db } = await this.credentials();
    await this.deps.outboxRecovery.discardPendingEnvelope(db, id).catch(() => undefined);
    await this.deps.db.deleteLocalMessage(db, id).catch(() => undefined);
    await this.deps.mediaPrep.discardMediaPreparation(db, id).catch(() => undefined);
    this.stored.delete(id);
    this.index.remove(id);
    this.handlers?.onMessageRemoved(id, false);
    this.deps.scheduled.wakeScheduledQueue();
  }

  private async retryScheduled(id: string): Promise<void> {
    const { db } = await this.credentials();
    const row = this.stored.get(id) ?? (await this.deps.db.loadLocalMessage(db, id));
    if (!row || row.client_id !== id || !row.scheduled_at) return;
    const now = new Date().toISOString();
    await this.deps.db.retryScheduledMessage(db, id, now);
    const pending: StoredE2eeMessage = { ...row, scheduled_at: now, send_error: null };
    this.stored.set(id, pending);
    this.index.upsert(this.render(pending));
    this.handlers?.onMessage(this.render(pending));
    this.deps.scheduled.wakeScheduledQueue();
  }

  private async credentials(): Promise<{
    db: E2eeDatabase['db'];
    account: E2eeAccountRow;
  }> {
    if (!this.db) {
      const opened = await this.deps.db.openE2eeDatabase(this.currentUser.id);
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
    if (!isOwnStoredMessage(stored, this.currentUser.id)) return 'none';
    if (stored.send_error) return 'failed';
    if (stored.client_id && stored.client_id === stored.id && stored.scheduled_at) {
      return 'pending';
    }
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
    if (this.queuedDecrypts.has(message.id)) return Promise.resolve();
    this.queuedDecrypts.add(message.id);
    const task = this.decryptChain.then(async () => {
      try {
        const { db, account } = await this.credentials();
        const result = await this.deps.crypto.decryptIncoming({
          token: this.token,
          db,
          account,
          message,
          currentUserId: this.currentUser.id,
        });
        if (result.ephemeralEvent) {
          if (result.ephemeralEvent.applied) {
            this.handlers?.onEphemeral?.(result.ephemeralEvent.ttlSeconds);
          }
        } else if (result.editEvent) {
          const target = result.editEvent.target ?? this.stored.get(result.editEvent.targetId);
          if (result.editEvent.applied && target) {
            this.stored.set(target.id, target);
            this.index.upsert(this.render(target));
            this.handlers?.onMessage(this.render(target));
          }
        } else if (result.reactionEvent) {
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
        const acked = this.deps.receipts.deliveredIds([result.stored], this.currentUser.id);
        if (acked.length > 0) this.reportDelivered(acked);
      } catch {
        // Un message illisible est déjà persisté avec son motif par le noyau :
        // l'écran affiche le libellé normalisé, jamais l'exception. Une erreur
        // d'ouverture de base ou de clé ne doit pas empoisonner la file : les
        // messages suivants gardent le droit d'être traités.
      } finally {
        this.queuedDecrypts.delete(message.id);
      }
    });
    // La queue ne porte jamais le rejet d'une tâche : elle sert uniquement de
    // jeton d'ordre pour le déchiffrement suivant.
    this.decryptChain = task.catch(() => undefined);
    return task;
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

  /** Une coupure REST ne doit ni perdre l'accusé ni produire de rejet non géré :
   *  les identifiants restent en attente jusqu'à la prochaine connexion. */
  private async flushReads(): Promise<void> {
    if (this.pendingReads.size === 0) return;
    const ids = [...this.pendingReads];
    try {
      await this.deps.api.markMessagesRead(this.token, this.conversationId, ids);
      for (const id of ids) this.pendingReads.delete(id);
    } catch {
      // La reconnexion relancera la même liste ; rien n'est marqué lu à tort.
    }
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
