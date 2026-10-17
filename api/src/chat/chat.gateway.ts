import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { ConversationsService } from '../conversations/conversations.service.js';

const roomOf = (conversationId: string) => `conv:${conversationId}`;

@WebSocketGateway({ cors: { origin: true } })
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly conversationsService: ConversationsService,
  ) {}

  async handleConnection(client: Socket) {
    const token = (client.handshake.auth as { token?: string } | undefined)?.token;
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token ?? '');
      if (payload.type && payload.type !== 'access') {
        throw new Error('invalid type');
      }
      client.data.userId = payload.sub;
    } catch {
      client.disconnect(true);
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

    const message = await this.conversationsService.createMessage(conversationId, userId, content);
    this.server.to(roomOf(conversationId)).emit('message:new', message);
    return message;
  }
}
