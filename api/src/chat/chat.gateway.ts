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
import type { JwtPayload } from '../auth/jwt-payload.js';
import {
  ConversationsService,
  type MessageDto,
  type ReceiptChange,
} from '../conversations/conversations.service.js';
import { PushService } from '../push/push.service.js';
import { MediaService } from '../media/media.service.js';

const roomOf = (conversationId: string) => `conv:${conversationId}`;
/** Salon personnel : la liste des discussions reçoit aussi les nouveaux messages. */
const userRoomOf = (userId: string) => `user:${userId}`;

@WebSocketGateway({ cors: { origin: true } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  /** Conversations réellement ouvertes, par socket (pour ne pas notifier
   *  quelqu'un qui est déjà en train de lire la discussion). */
  private readonly viewing = new Map<string, { userId: string; conversationId: string }>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly conversationsService: ConversationsService,
    private readonly pushService: PushService,
    private readonly media: MediaService,
  ) {}

  async handleConnection(client: Socket) {
    const token = (client.handshake.auth as { token?: string } | undefined)?.token;
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token ?? '');
      if (payload.type !== 'access') {
        throw new Error('invalid type');
      }
      client.data.userId = payload.sub;
      // Chaque appareil suit ses propres conversations, même celles qu'il ne
      // connaît pas encore (nouvelle discussion ouverte par quelqu'un).
      await client.join(userRoomOf(payload.sub));
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.viewing.delete(client.id);
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
      attachmentId?: string;
      clientId?: string;
      replyToId?: string;
    },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    const content = body?.content?.trim() ?? '';
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
    if (!userId) {
      throw new WsException('Not authenticated');
    }
    if (!conversationId || (!content && !attachmentId)) {
      throw new WsException('conversationId and content or attachmentId are required');
    }
    if (content.length > 4000) {
      throw new WsException('Message is too long (max 4000 characters)');
    }

    const message = await this.conversationsService
      .createMessage(conversationId, userId, content, attachmentId, clientId, replyToId)
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
