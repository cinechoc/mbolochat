import { OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { authenticateSocket, userRoomOf } from './socket-auth.js';
import {
  ConversationsService,
  type MessageDto,
  type ReceiptChange,
} from '../conversations/conversations.service.js';
import {
  ConversationEventsService,
  type ConversationChange,
} from '../conversations/conversation-events.service.js';
import { PushService } from '../push/push.service.js';
import { MediaService } from '../media/media.service.js';
import { PresenceService, type PresenceChange } from '../presence/presence.service.js';
import { SocketRateLimiter } from './socket-rate-limit.js';
import { InvalidGifAttachmentError, normalizeGifAttachment } from './gif-attachment.js';
import {
  InvalidStickerAttachmentError,
  normalizeStickerAttachment,
  type StickerAttachmentMeta,
} from './sticker-attachment.js';
import { isMessageType, isValidStickerRef, type MessageType } from './sticker-ref.js';

const roomOf = (conversationId: string) => `conv:${conversationId}`;

@WebSocketGateway({ cors: { origin: true } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  /** Conversations réellement ouvertes, par socket (pour ne pas notifier
   *  quelqu'un qui est déjà en train de lire la discussion). */
  private readonly viewing = new Map<string, { userId: string; conversationId: string }>();

  /** Utilisateurs dont ce socket suit la présence (50 au maximum par socket). */
  private readonly presenceSubscriptions = new Map<
    string,
    { userId: string; targets: Set<string> }
  >();
  private readonly presenceChanges: Subscription;
  private readonly conversationChanges: Subscription;

  constructor(
    private readonly jwtService: JwtService,
    private readonly conversationsService: ConversationsService,
    private readonly conversationEvents: ConversationEventsService,
    private readonly pushService: PushService,
    private readonly media: MediaService,
    private readonly presence: PresenceService,
    private readonly rateLimiter: SocketRateLimiter,
  ) {
    this.presenceChanges = this.presence.changes$.subscribe((change) => {
      void this.broadcastPresenceChange(change);
    });
    this.conversationChanges = this.conversationEvents.changes$.subscribe((change) => {
      void this.broadcastConversationChange(change);
    });
  }

  onModuleDestroy(): void {
    this.presenceChanges.unsubscribe();
    this.conversationChanges.unsubscribe();
  }

  async handleConnection(client: Socket) {
    // Chaque appareil suit ses propres conversations, même celles qu'il ne
    // connaît pas encore (nouvelle discussion ouverte par quelqu'un).
    await authenticateSocket(client, this.jwtService);
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    this.viewing.delete(client.id);
    this.presenceSubscriptions.delete(client.id);
    if (userId) this.presence.disconnect(userId, client.id);
  }

  /** La discussion est à l'écran : les nouveaux messages ne sont pas notifiés. */
  @SubscribeMessage('conversation:focus')
  async focus(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    if (!userId || !conversationId) return;
    if (!(await this.conversationsService.isMember(conversationId, userId))) return;
    this.viewing.set(client.id, { userId, conversationId });
  }

  @SubscribeMessage('conversation:blur')
  blur(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }) {
    const current = this.viewing.get(client.id);
    if (current && (!body?.conversationId || current.conversationId === body.conversationId)) {
      this.viewing.delete(client.id);
    }
  }

  @SubscribeMessage('conversation:join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    if (!userId || !conversationId || !(await this.conversationsService.isMember(conversationId, userId))) {
      throw new WsException('Not a member of this conversation');
    }
    await client.join(roomOf(conversationId));
    return { joined: conversationId };
  }

  @SubscribeMessage('message:send')
  async send(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      conversationId?: string;
      content?: string;
      /** Type applicatif : « text » par défaut, ou « sticker » avec stickerRef. */
      type?: string;
      /** Référence de catalogue d'un sticker (« pack/sticker »). */
      stickerRef?: string;
      attachmentId?: string;
      /** GIF GIPHY externe : URL média + métadonnées, validée côté serveur. */
      gif?: unknown;
      /** Sticker Mbolo : identifiants opaques, l'image arrive par attachmentId. */
      sticker?: unknown;
      clientId?: string;
      replyToId?: string;
    },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    const content = body?.content?.trim() ?? '';
    if (body?.type !== undefined && !isMessageType(body.type)) {
      throw new WsException('Type de message invalide');
    }
    const messageType: MessageType = body?.type === 'sticker' ? 'sticker' : 'text';
    const hasStickerRef = body?.stickerRef !== undefined && body?.stickerRef !== null;
    const stickerRef =
      typeof body?.stickerRef === 'string' ? body.stickerRef : undefined;
    const attachmentId =
      typeof body?.attachmentId === 'string' && body.attachmentId.length > 0
        ? body.attachmentId
        : undefined;
    // Clé d'idempotence de l'appareil : une reprise après coupure renvoie le
    // message déjà enregistré au lieu d'en créer un deuxième.
    const clientId =
      typeof body?.clientId === 'string' && body.clientId.length > 0 && body.clientId.length <= 64
        ? body.clientId
        : undefined;
    const replyToId =
      typeof body?.replyToId === 'string' && body.replyToId.length > 0 && body.replyToId.length <= 64
        ? body.replyToId
        : undefined;
    // Pièce jointe GIF externe (GIPHY) : le client a choisi l'URL dans l'API
    // GIPHY ; le serveur se contente de vérifier l'allowlist des CDN.
    let gifAttachment: ReturnType<typeof normalizeGifAttachment> | null = null;
    if (body?.gif != null) {
      try {
        gifAttachment = normalizeGifAttachment(body.gif);
      } catch (error) {
        if (error instanceof InvalidGifAttachmentError) {
          throw new WsException(error.message);
        }
        throw error;
      }
    }
    if (!userId) {
      throw new WsException('Not authenticated');
    }
    let stickerAttachment: StickerAttachmentMeta | null = null;
    if (body?.sticker != null) {
      if (!attachmentId) {
        throw new WsException("L'image du sticker doit être importée");
      }
      try {
        stickerAttachment = normalizeStickerAttachment(body.sticker);
      } catch (error) {
        if (error instanceof InvalidStickerAttachmentError) {
          throw new WsException(error.message);
        }
        throw error;
      }
    }
    if (messageType === 'sticker') {
      if (!isValidStickerRef(stickerRef)) {
        throw new WsException('Référence de sticker invalide');
      }
      if (attachmentId || gifAttachment || stickerAttachment) {
        throw new WsException('Un sticker ne porte pas de pièce jointe');
      }
    } else if (hasStickerRef) {
      throw new WsException('stickerRef n’est valide que pour un sticker');
    }
    if (!this.rateLimiter.allowMessage(userId)) {
      return { error: 'Trop de messages envoyés. Réessaie dans un instant.' };
    }
    if (
      !conversationId ||
      (!content && !attachmentId && !gifAttachment && messageType !== 'sticker')
    ) {
      throw new WsException('conversationId and content or attachmentId are required');
    }
    if (content.length > 4000) {
      throw new WsException('Message is too long (max 4000 characters)');
    }

    const message = await this.conversationsService
      .createMessage(
        conversationId,
        userId,
        content,
        attachmentId,
        clientId,
        replyToId,
        gifAttachment,
        stickerAttachment,
        messageType,
        stickerRef,
      )
      .catch((error: unknown) => {
        // L'acquittement porte l'erreur : le client peut l'afficher
        // (message bloqué, quota atteint, etc.) au lieu d'attendre indéfiniment.
        return { error: error instanceof Error ? error.message : "L'envoi a échoué" };
      });
    if ('error' in message) {
      return message;
    }
    // Diffusion unique : salon de la conversation (écran ouvert) + salon
    // personnel de chaque membre (liste des discussions, y compris une
    // conversation qui vient d'être créée). Socket.IO n'envoie qu'une fois
    // par socket, même si elle est dans plusieurs de ces salons.
    const memberIds = await this.conversationsService.listMemberIds(conversationId);
    let broadcast = this.server.to(roomOf(conversationId));
    for (const memberId of memberIds) {
      broadcast = broadcast.to(userRoomOf(memberId));
    }
    // Le temps réel ne traverse pas l'intercepteur des réponses HTTP : les
    // médias sont signés ici, sinon l'image ne s'afficherait nulle part.
    const payload = this.media.signMessage(message);
    broadcast.emit('message:new', payload);
    // Notifications push en arrière-plan : l'ack du message ne les attend pas.
    void this.notifyPush(payload, conversationId);
    return payload;
  }

  /**
   * Le destinataire confirme avoir reçu ces messages : c'est la coche « reçue ».
   * L'expéditeur est prévenu dans la foulée, sur son salon personnel.
   */
  @SubscribeMessage('message:ack')
  async ack(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { messageIds?: string[] },
  ) {
    const userId = client.data.userId as string | undefined;
    const messageIds = Array.isArray(body?.messageIds)
      ? body.messageIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (!userId || messageIds.length === 0) return { acked: 0 };
    const changes = await this.conversationsService.markDelivered(userId, messageIds);
    this.emitReceipts(changes);
    return { acked: changes.length };
  }

  /**
   * Retrait d'un message, depuis le menu d'appui long.
   *
   * « Pour tous » est réservé à l'auteur et vide réellement la ligne. « Pour moi
   * » ne change que la vue de celui qui le demande : les autres membres
   * continuent de lire le message, et son propre appareil ne le reverra plus.
   */
  /** Ajoute ou retire une réaction, puis diffuse le résumé à tout le groupe. */
  @SubscribeMessage('message:react')
  async react(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string; messageId?: string; reaction?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    const messageId = body?.messageId;
    if (!userId || !conversationId || !messageId || typeof body?.reaction !== 'string') {
      throw new WsException('Réaction invalide');
    }
    const reactions = await this.conversationsService.toggleReaction(
      conversationId,
      messageId,
      userId,
      body.reaction,
    );
    const payload = { conversationId, messageId, reactions };
    const memberIds = await this.conversationsService.listMemberIds(conversationId);
    this.server
      .to([roomOf(conversationId), ...memberIds.map((memberId) => userRoomOf(memberId))])
      .emit('message:reaction', payload);
    return { reactions };
  }

  @SubscribeMessage('message:delete')
  async remove(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string; messageId?: string; forEveryone?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    const messageId = body?.messageId;
    if (!userId || !conversationId || !messageId) {
      throw new WsException('conversationId and messageId are required');
    }

    const forEveryone = Boolean(body.forEveryone);
    const outcome = forEveryone
      ? await this.refused(() => this.conversationsService.deleteForEveryone(conversationId, messageId, userId))
      : await this.refused(() => this.conversationsService.hideForMe(conversationId, [messageId], userId));
    if ('error' in outcome) {
      return outcome;
    }

    if (!forEveryone) {
      // Retiré de la seule vue de ce compte : son salon personnel suffit.
      this.server.to(userRoomOf(userId)).emit('message:deleted', {
        conversationId,
        messageId,
        forEveryone: false,
      });
      return { deleted: messageId, forEveryone: false };
    }

    const memberIds = await this.conversationsService.listMemberIds(conversationId);
    let broadcast = this.server.to(roomOf(conversationId));
    for (const memberId of memberIds) {
      broadcast = broadcast.to(userRoomOf(memberId));
    }
    broadcast.emit('message:deleted', { conversationId, messageId, forEveryone: true });
    return { deleted: messageId, forEveryone: true };
  }

  /** Un refus du service devient un acquittement d'erreur, jamais une exception. */
  private async refused<T>(call: () => Promise<T>): Promise<T | { error: string }> {
    try {
      return await call();
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Opération impossible' };
    }
  }

  /**
   * Prévient les membres absents de la conversation. Ceux qui l'ont ouverte
   * à l'écran voient déjà le message : inutile de les notifier.
   */
  private async notifyPush(message: MessageDto, conversationId: string): Promise<void> {
    const activeUserIds = [...this.viewing.values()]
      .filter((entry) => entry.conversationId === conversationId)
      .map((entry) => entry.userId);
    await this.pushService.notifyNewMessage(message, activeUserIds);
  }

  @SubscribeMessage('typing')
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string; text?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    if (!userId || !conversationId) return;
    if (!(await this.conversationsService.isMember(conversationId, userId))) return;
    const text = typeof body?.text === 'string' ? body.text.slice(0, 300) : '';
    client.to(roomOf(conversationId)).emit('typing', { conversationId, userId, text });
  }

  @SubscribeMessage('message:read')
  async read(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    if (!userId || !conversationId) return;
    if (!(await this.conversationsService.isMember(conversationId, userId))) return;
    const changes = await this.conversationsService.markRead(conversationId, userId);
    this.server.to(roomOf(conversationId)).emit('read', { conversationId, userId, at: new Date().toISOString() });
    this.emitReceipts(changes);
  }

  /**
   * Présence : le socket est l'appareil. Un utilisateur ne peut signaler que
   * sa propre présence, jamais celle d'un autre identifiant.
   */
  @SubscribeMessage('presence:foreground')
  foreground(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { online: false };
    if (!this.rateLimiter.allowPresence(userId)) {
      return { error: 'Trop d’événements de présence. Réessaie dans un instant.' };
    }
    this.presence.foreground(userId, client.id);
    return { online: true };
  }

  @SubscribeMessage('presence:background')
  background(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { online: false };
    if (!this.rateLimiter.allowPresence(userId)) {
      return { error: 'Trop d’événements de présence. Réessaie dans un instant.' };
    }
    void this.presence.background(userId, client.id);
    return { online: false };
  }

  @SubscribeMessage('presence:heartbeat')
  heartbeat(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false };
    if (!this.rateLimiter.allowPresence(userId)) {
      return { error: 'Trop d’événements de présence. Réessaie dans un instant.' };
    }
    this.presence.heartbeat(userId, client.id);
    return { ok: true };
  }

  @SubscribeMessage('presence:logout')
  async presenceLogout(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false };
    if (!this.rateLimiter.allowPresence(userId)) {
      return { error: 'Trop d’événements de présence. Réessaie dans un instant.' };
    }
    this.presenceSubscriptions.delete(client.id);
    await this.presence.logout(userId, client.id);
    return { ok: true };
  }

  /**
   * Abonnement aux utilisateurs visibles à l'écran. Le plafond de 50 est
   * appliqué par socket, et chaque état renvoyé est déjà filtré.
   */
  @SubscribeMessage('presence:subscribe')
  async subscribePresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userIds?: unknown },
  ) {
    const userId = client.data.userId as string | undefined;
    const ids = Array.isArray(body?.userIds)
      ? body.userIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64,
        )
      : [];
    if (!userId || ids.length === 0) return { subscribed: 0 };
    if (!this.rateLimiter.allowPresence(userId)) {
      return { error: 'Trop d’événements de présence. Réessaie dans un instant.' };
    }

    const entry =
      this.presenceSubscriptions.get(client.id) ?? {
        userId,
        targets: new Set<string>(),
      };
    for (const id of ids) {
      if (entry.targets.size >= 50) break;
      entry.targets.add(id);
    }
    this.presenceSubscriptions.set(client.id, entry);

    try {
      const snapshot = await this.presence.getPresenceForViewer(userId, [...entry.targets]);
      client.emit('presence:update', snapshot);
    } catch {
      // Une base momentanément indisponible ne doit pas tuer le socket.
    }
    return { subscribed: entry.targets.size };
  }

  @SubscribeMessage('presence:unsubscribe')
  unsubscribePresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userIds?: unknown },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { subscribed: 0 };
    if (!this.rateLimiter.allowPresence(userId)) {
      return { error: 'Trop d’événements de présence. Réessaie dans un instant.' };
    }
    const entry = this.presenceSubscriptions.get(client.id);
    if (!entry) return { subscribed: 0 };
    const ids = Array.isArray(body?.userIds) ? body.userIds : [];
    for (const id of ids) {
      if (typeof id === 'string') entry.targets.delete(id);
    }
    if (entry.targets.size === 0) {
      this.presenceSubscriptions.delete(client.id);
    }
    return { subscribed: entry.targets.size };
  }

  /**
   * Diffusion ciblée : uniquement les sockets abonnés à la cible, avec le
   * filtrage propre à chaque spectateur.
   */
  /**
   * Diffuse les mutations de groupe. Un membre retiré doit aussi sortir du
   * salon : sinon il continuerait de recevoir les messages après son exclusion.
   */
  private async broadcastConversationChange(change: ConversationChange): Promise<void> {
    if (!this.server) return;

    if (change.kind === 'message') {
      const memberIds = await this.conversationsService.listMemberIds(change.conversationId);
      this.server
        .to([
          roomOf(change.conversationId),
          ...memberIds.map((memberId) => userRoomOf(memberId)),
        ])
        .emit('message:new', change.message);
      return;
    }

    if (change.kind === 'created') {
      for (const userId of change.userIds) {
        this.server
          .to(userRoomOf(userId))
          .emit('conversation:added', { conversationId: change.conversationId });
      }
      return;
    }

    let state;
    try {
      state = await this.conversationsService.groupState(change.conversationId);
    } catch {
      // Conversation supprimée entre-temps : plus rien à diffuser.
      return;
    }

    const members = state.members.map((member) => ({
      ...member,
      avatarUrl: this.media.signOrNull(member.avatarUrl),
    }));
    const group = {
      id: state.id,
      name: state.name,
      description: state.description,
      emoji: state.emoji,
      color: state.color,
      avatarUrl: this.media.signOrNull(state.avatarUrl),
      ownerId: state.ownerId,
      whoCanSend: state.whoCanSend,
      whoCanAdd: state.whoCanAdd,
      memberCount: state.memberCount,
      updatedAt: state.updatedAt,
    };
    const rooms = [
      roomOf(change.conversationId),
      ...members.map((member) => userRoomOf(member.id)),
    ];

    if (change.kind === 'updated') {
      this.server.to(rooms).emit('group:updated', {
        conversationId: change.conversationId,
        group,
        members,
      });
      return;
    }

    if (change.action === 'added') {
      for (const userId of change.userIds) {
        this.server
          .to(userRoomOf(userId))
          .emit('conversation:added', { conversationId: change.conversationId });
      }
    }

    if (change.action === 'removed' || change.action === 'left') {
      for (const userId of change.userIds) {
        this.server.to(userRoomOf(userId)).emit('conversation:removed', {
          conversationId: change.conversationId,
          reason: change.action === 'left' ? 'left' : 'removed',
        });
        this.server.in(userRoomOf(userId)).socketsLeave(roomOf(change.conversationId));
        for (const [socketId, entry] of this.viewing) {
          if (entry.userId === userId && entry.conversationId === change.conversationId) {
            this.viewing.delete(socketId);
          }
        }
      }
    }

    this.server.to(rooms).emit('members:changed', {
      conversationId: change.conversationId,
      action: change.action,
      actorId: change.actorId,
      userIds: change.userIds,
      group,
      members,
    });
  }

  private async broadcastPresenceChange(change: PresenceChange): Promise<void> {
    if (!this.server) return;
    await this.broadcastToSubscribers(change.userId);
    if (change.settings) {
      await this.broadcastViewerSubscriptions(change.userId);
    }
  }

  private async broadcastToSubscribers(targetId: string): Promise<void> {
    const byViewer = new Map<string, string[]>();
    for (const [socketId, entry] of this.presenceSubscriptions) {
      if (!entry.targets.has(targetId)) continue;
      const list = byViewer.get(entry.userId);
      if (list) list.push(socketId);
      else byViewer.set(entry.userId, [socketId]);
    }
    for (const [viewerId, socketIds] of byViewer) {
      const snapshot = await this.presence
        .getPresenceForViewer(viewerId, [targetId])
        .catch(() => null);
      if (!snapshot) continue;
      for (const socketId of socketIds) {
        this.server.to(socketId).emit('presence:update', snapshot);
      }
    }
  }

  /**
   * Les réglages d'un utilisateur changent aussi ce qu'il voit des autres
   * (réciprocité) : on recalcule les abonnements de chacun de ses appareils.
   */
  private async broadcastViewerSubscriptions(viewerId: string): Promise<void> {
    for (const [socketId, entry] of this.presenceSubscriptions) {
      if (entry.userId !== viewerId || entry.targets.size === 0) continue;
      const snapshot = await this.presence
        .getPresenceForViewer(viewerId, [...entry.targets])
        .catch(() => null);
      if (!snapshot) continue;
      this.server.to(socketId).emit('presence:update', snapshot);
    }
  }

  /**
   * Prévient chaque expéditeur des accusés qui concernent ses messages. Un seul
   * événement par expéditeur, même s'il a plusieurs messages dans le lot.
   */
  private emitReceipts(changes: ReceiptChange[]): void {
    if (changes.length === 0) return;
    const bySender = new Map<string, ReceiptChange[]>();
    for (const change of changes) {
      const list = bySender.get(change.senderId);
      if (list) {
        list.push(change);
      } else {
        bySender.set(change.senderId, [change]);
      }
    }
    for (const [senderId, receipts] of bySender) {
      this.server.to(userRoomOf(senderId)).emit('receipt', { receipts });
    }
  }
}
