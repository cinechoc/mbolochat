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
import { ConversationsService, type MessageDto } from '../conversations/conversations.service.js';
import { PushService } from '../push/push.service.js';

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
  ) {}

  async handleConnection(client: Socket) {
    const token = (client.handshake.auth as { token?: string } | undefined)?.token;
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token ?? '');
      if (payload.type && payload.type !== 'access') {
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
    @MessageBody() body: { conversationId?: string; content?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    const conversationId = body?.conversationId;
    const content = body?.content?.trim();
    if (!userId) {
      throw new WsException('Not authenticated');
    }
    if (!conversationId || !content) {
      throw new WsException('conversationId and content are required');
    }
    if (content.length > 4000) {
      throw new WsException('Message is too long (max 4000 characters)');
    }

    const message = await this.conversationsService
      .createMessage(conversationId, userId, content)
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
    broadcast.emit('message:new', message);
    // Notifications push en arrière-plan : l'ack du message ne les attend pas.
    void this.notifyPush(message, conversationId);
    return message;
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
    await this.conversationsService.markRead(conversationId, userId);
    this.server.to(roomOf(conversationId)).emit('read', { conversationId, userId, at: new Date().toISOString() });
  }
}
