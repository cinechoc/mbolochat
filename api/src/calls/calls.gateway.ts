import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { authenticateSocket, userRoomOf } from '../chat/socket-auth.js';
import { CallsService } from './calls.service.js';

/**
 * Signalisation des appels vocaux : mêmes sockets que le chat (auth JWT), les
 * événements sont routés par le salon personnel `user:<id>`.
 */
@WebSocketGateway({ cors: { origin: true } })
export class CallsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly calls: CallsService,
  ) {}

  afterInit(server: Server) {
    this.calls.attach(server);
  }

  async handleConnection(client: Socket) {
    // ChatGateway authentifie aussi ; on ne refait le travail que si nécessaire.
    if (!client.data.userId) {
      await authenticateSocket(client, this.jwtService);
    }
    const userId = client.data.userId as string | undefined;
    if (userId) {
      this.calls.handleUserOnline(userId);
      // App rouverte depuis la notification d'appel : l'invitation est encore valide.
      this.calls.resendIncoming(userId);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return;
    }
    const room = this.server.sockets.adapter.rooms.get(userRoomOf(userId));
    if (!room || room.size === 0) {
      this.calls.handleUserOffline(userId);
    }
  }

  @SubscribeMessage('call:invite')
  invite(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string; video?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'invalid' };
    }
    return this.calls.invite(userId, body?.conversationId, body?.video === true);
  }

  @SubscribeMessage('call:accept')
  accept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; video?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    return (
      Boolean(userId) && this.calls.accept(userId ?? '', body?.callId, body?.video === true).ok
    );
  }

  @SubscribeMessage('call:video-toggle')
  videoToggle(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; video?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.calls.toggleVideo(userId, body?.callId, body?.video === true);
  }

  @SubscribeMessage('call:reject')
  reject(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; reason?: 'declined' | 'busy' },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.calls.reject(userId, body?.callId, body?.reason ?? 'declined');
  }

  @SubscribeMessage('call:cancel')
  cancel(@ConnectedSocket() client: Socket, @MessageBody() body: { callId?: string }) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.calls.cancel(userId, body?.callId);
  }

  @SubscribeMessage('call:end')
  end(@ConnectedSocket() client: Socket, @MessageBody() body: { callId?: string }) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.calls.end(userId, body?.callId);
  }

  @SubscribeMessage('call:offer')
  offer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; sdp?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.sdp) {
      return { ok: false };
    }
    return this.calls.relay(userId, body.callId, 'call:offer', {
      sdp: body.sdp,
      type: 'offer',
    });
  }

  @SubscribeMessage('call:answer')
  answer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; sdp?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.sdp) {
      return { ok: false };
    }
    return this.calls.relay(userId, body.callId, 'call:answer', {
      sdp: body.sdp,
      type: 'answer',
    });
  }

  @SubscribeMessage('call:ice')
  ice(@ConnectedSocket() client: Socket, @MessageBody() body: { callId?: string; candidate?: unknown }) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.candidate) {
      return { ok: false };
    }
    return this.calls.relay(userId, body.callId, 'call:ice', { candidate: body.candidate });
  }
}
