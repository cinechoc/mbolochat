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
import { GroupCallsService } from './group-calls.service.js';
import type { GroupCallSignalPayload } from './calls.types.js';

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
    private readonly groupCalls: GroupCallsService,
  ) {}

  afterInit(server: Server) {
    this.calls.attach(server);
    this.groupCalls.attach(server);
  }

  async handleConnection(client: Socket) {
    // ChatGateway authentifie aussi ; on ne refait le travail que si nécessaire.
    if (!client.data.userId) {
      await authenticateSocket(client, this.jwtService);
    }
    const userId = client.data.userId as string | undefined;
    if (userId) {
      this.calls.handleUserOnline(userId);
      this.groupCalls.handleUserOnline(userId);
      // App rouverte depuis la notification d'appel : l'invitation est encore valide.
      this.calls.resendIncoming(userId);
      this.groupCalls.resendInvite(userId);
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
      this.groupCalls.handleUserOffline(userId);
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
    // Deux appels à la fois : un appel de groupe ouvert rend l'utilisateur occupé.
    if (this.groupCalls.isInCall(userId)) {
      return { ok: false, error: 'busy' };
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

  /* ------------------------------ appels de groupe ------------------------------ */

  @SubscribeMessage('gcall:start')
  async groupStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string; media?: 'AUDIO' | 'VIDEO' },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'invalid' };
    }
    if (this.calls.isBusy(userId)) {
      return { ok: false, error: 'busy' };
    }
    return this.groupCalls.start(userId, body?.conversationId, body?.media ?? 'AUDIO');
  }

  @SubscribeMessage('gcall:leave')
  groupLeave(@ConnectedSocket() client: Socket, @MessageBody() body: { callId?: string }) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.leave(userId, body?.callId);
  }

  @SubscribeMessage('gcall:decline')
  groupDecline(@ConnectedSocket() client: Socket, @MessageBody() body: { callId?: string }) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.decline(userId, body?.callId);
  }

  @SubscribeMessage('gcall:add')
  async groupAdd(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; userIds?: string[] },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'invalid' };
    }
    return this.groupCalls.add(userId, body?.callId, body?.userIds ?? []);
  }

  @SubscribeMessage('gcall:kick')
  async groupKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; userId?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.userId) {
      return { ok: false, error: 'invalid' };
    }
    return this.groupCalls.kick(userId, body.callId, body.userId);
  }

  @SubscribeMessage('gcall:media')
  groupMedia(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; media?: 'AUDIO' | 'VIDEO' },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.media) {
      return { ok: false, error: 'invalid' };
    }
    return this.groupCalls.setMedia(userId, body.callId, body.media);
  }

  @SubscribeMessage('gcall:video')
  groupVideo(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; video?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.setVideo(userId, body?.callId, body?.video === true);
  }

  @SubscribeMessage('gcall:mute')
  groupMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; muted?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.setMute(userId, body?.callId, body?.muted === true);
  }

  @SubscribeMessage('gcall:offer')
  groupOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GroupCallSignalPayload,
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.relay(userId, body?.callId, 'gcall:offer', body);
  }

  @SubscribeMessage('gcall:answer')
  groupAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GroupCallSignalPayload,
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.relay(userId, body?.callId, 'gcall:answer', body);
  }

  @SubscribeMessage('gcall:ice')
  groupIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GroupCallSignalPayload,
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    return this.groupCalls.relay(userId, body?.callId, 'gcall:ice', body);
  }
}
