import type { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSummary } from '../conversations/conversations.service.js';
import type { ConversationsService } from '../conversations/conversations.service.js';
import type { PresenceService } from '../presence/presence.service.js';
import type { PushService } from '../push/push.service.js';
import type { UsersService } from '../users/users.service.js';
import type { SocketRateLimiter } from '../chat/socket-rate-limit.js';
import { CALL_DISCONNECT_GRACE_MS, CALL_RING_TIMEOUT_MS, CallsService } from './calls.service.js';

const CALLER = 'caller-id';
const CALLEE = 'callee-id';

type Emitted = { room: string; event: string; payload: any };

function summary(type: 'DIRECT' | 'GROUP' = 'DIRECT'): ConversationSummary[] {
  return [
    {
      type,
      members: [
        { id: CALLER, displayName: 'Alice', avatarUrl: null },
        { id: CALLEE, displayName: 'Bob', avatarUrl: null },
      ],
    } as unknown as ConversationSummary,
  ];
}

describe('CallsService', () => {
  let emitted: Emitted[];
  let conversations: {
    listForUser: ReturnType<typeof vi.fn>;
    listMemberIds: ReturnType<typeof vi.fn>;
    createCallMessage: ReturnType<typeof vi.fn>;
  };
  let users: { isBlockedBetween: ReturnType<typeof vi.fn> };
  let push: {
    notifyIncomingCall: ReturnType<typeof vi.fn>;
    notifyCallUpdate: ReturnType<typeof vi.fn>;
  };
  let presence: { isOnline: ReturnType<typeof vi.fn> };
  let limiter: { allowCall: ReturnType<typeof vi.fn> };
  let service: CallsService;

  function operator(rooms: string[]) {
    return {
      to: (room: string) => operator([...rooms, room]),
      emit: (event: string, payload: any) => {
        for (const room of rooms) {
          emitted.push({ room, event, payload });
        }
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    conversations = {
      listForUser: vi.fn().mockResolvedValue(summary()),
      listMemberIds: vi.fn().mockResolvedValue([CALLER, CALLEE]),
      createCallMessage: vi.fn().mockImplementation((conversationId: string, senderId: string, content: string) =>
        Promise.resolve({
          id: 'call-message-id',
          conversationId,
          type: 'call',
          content,
          sender: { id: senderId },
        }),
      ),
    };
    users = { isBlockedBetween: vi.fn().mockResolvedValue(false) };
    push = {
      notifyIncomingCall: vi.fn().mockResolvedValue(undefined),
      notifyCallUpdate: vi.fn().mockResolvedValue(undefined),
    };
    presence = { isOnline: vi.fn().mockReturnValue(false) };
    limiter = { allowCall: vi.fn().mockReturnValue(true) };
    service = new CallsService(
      conversations as unknown as ConversationsService,
      users as unknown as UsersService,
      push as unknown as PushService,
      presence as unknown as PresenceService,
      limiter as unknown as SocketRateLimiter,
    );
    const server = { to: (room: string) => operator([room]) };
    service.attach(server as unknown as Server);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  const eventsFor = (userId: string) =>
    emitted.filter((entry) => entry.room === `user:${userId}`).map((entry) => entry.event);

  const notice = () => emitted.find((entry) => entry.event === 'message:new');

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('route l’invitation au destinataire et démarre la sonnerie', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    expect(ack.ok).toBe(true);
    expect(eventsFor(CALLEE)).toContain('call:incoming');
    expect(eventsFor(CALLER)).toContain('call:ringing');
    // Appelé hors ligne : notification plein écran.
    expect(push.notifyIncomingCall).toHaveBeenCalledOnce();
    expect(push.notifyIncomingCall.mock.calls[0][0].video).toBe(false);
  });

  it('ne pousse pas de notification si l’appelé est en ligne', async () => {
    presence.isOnline.mockReturnValue(true);
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    expect(push.notifyIncomingCall).not.toHaveBeenCalled();

    // Raccrochage : rien à annuler côté notification.
    service.cancel(CALLER, ack.callId);
    await flush();
    expect(push.notifyCallUpdate).not.toHaveBeenCalled();
  });

  it('annule la notification quand l’appelant raccroche', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    service.cancel(CALLER, ack.callId);
    await flush();
    expect(push.notifyCallUpdate).toHaveBeenCalledOnce();
    expect(push.notifyCallUpdate.mock.calls[0][0].outcome).toBe('cancelled');
  });

  it('refuse un appel si l’un des deux est déjà en ligne', async () => {
    const first = await service.invite(CALLER, 'conv-1');
    expect(first.ok).toBe(true);
    const second = await service.invite(CALLER, 'conv-1');
    expect(second).toEqual({ ok: false, error: 'busy' });

    // Le destinataire est aussi occupé.
    conversations.listForUser.mockResolvedValueOnce(summary());
    const third = await service.invite(CALLEE, 'conv-1');
    expect(third).toEqual({ ok: false, error: 'busy' });
  });

  it('refuse un blocage, un groupe et un non-membre', async () => {
    users.isBlockedBetween.mockResolvedValueOnce(true);
    expect(await service.invite(CALLER, 'conv-1')).toEqual({ ok: false, error: 'unavailable' });

    conversations.listForUser.mockResolvedValueOnce(summary('GROUP'));
    expect(await service.invite(CALLER, 'conv-1')).toEqual({ ok: false, error: 'invalid' });

    conversations.listForUser.mockResolvedValueOnce([]);
    expect(await service.invite(CALLER, 'conv-1')).toEqual({ ok: false, error: 'invalid' });
  });

  it('expire la sonnerie après le délai et libère les deux utilisateurs', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    expect(ack.ok).toBe(true);
    emitted = [];

    vi.advanceTimersByTime(CALL_RING_TIMEOUT_MS);
    await flush();

    expect(eventsFor(CALLEE)).toEqual(expect.arrayContaining(['call:missed', 'call:ended']));
    expect(emitted.find((e) => e.event === 'call:ended')?.payload.reason).toBe('timeout');
    expect(notice()?.payload.content).toBe('Appel manqué');
    expect(push.notifyCallUpdate.mock.calls[0][0].outcome).toBe('missed');

    // Les deux sont libres : une nouvelle invitation passe.
    conversations.listForUser.mockResolvedValueOnce(summary());
    expect((await service.invite(CALLER, 'conv-1')).ok).toBe(true);
  });

  it('transmet le refus au demandeur, nettoie l’appel et écrit un message système', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    emitted = [];

    expect(service.reject(CALLEE, ack.callId).ok).toBe(true);
    await flush();
    expect(eventsFor(CALLER)).toContain('call:rejected');
    expect(service.end(CALLER, ack.callId).ok).toBe(false);
    expect(notice()?.payload.content).toBe('Appel refusé');
    // Diffusion : conversation ouverte + liste des deux membres.
    expect(notice()?.room).toMatch(/^conv:|^user:/);
    expect(conversations.createCallMessage).toHaveBeenCalledOnce();
  });

  it('écrit la durée une seule fois à la fin d’un appel abouti', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    expect(service.accept(CALLEE, ack.callId).ok).toBe(true);
    vi.advanceTimersByTime(65_000);
    emitted = [];

    expect(service.end(CALLEE, ack.callId).ok).toBe(true);
    await flush();
    expect(notice()?.payload.content).toBe('Appel vocal · 1:05');
    expect(notice()?.payload.type).toBe('call');
    expect(conversations.createCallMessage).toHaveBeenCalledOnce();
    expect(conversations.listMemberIds).toHaveBeenCalledWith('conv-1');
  });

  it('transmet le mode vidéo et titre le message final', async () => {
    const ack = await service.invite(CALLER, 'conv-1', true);
    if (!ack.ok) throw new Error('invite failed');
    expect(emitted.find((e) => e.event === 'call:incoming')?.payload.video).toBe(true);
    expect(service.accept(CALLEE, ack.callId, true).ok).toBe(true);
    expect(emitted.find((e) => e.event === 'call:accepted')?.payload.video).toBe(true);

    vi.advanceTimersByTime(65_000);
    emitted = [];
    expect(service.end(CALLER, ack.callId).ok).toBe(true);
    await flush();
    expect(notice()?.payload.content).toBe('Appel vidéo · 1:05');
  });

  it('relaie la bascule caméra au pair et retient le type vidéo', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    service.accept(CALLEE, ack.callId);
    vi.advanceTimersByTime(5_000);
    emitted = [];

    expect(service.toggleVideo(CALLEE, ack.callId, true).ok).toBe(true);
    expect(eventsFor(CALLER)).toContain('call:video-toggle');
    expect(emitted.find((e) => e.event === 'call:video-toggle')?.payload.video).toBe(true);
    expect(service.toggleVideo('intruder', ack.callId, true).ok).toBe(false);

    service.end(CALLER, ack.callId);
    await flush();
    expect(notice()?.payload.content).toBe('Appel vidéo · 0:05');
  });

  it('relaie offer/answer/ice au seul autre participant', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    expect(service.accept(CALLEE, ack.callId).ok).toBe(true);
    emitted = [];

    expect(service.relay(CALLER, ack.callId, 'call:offer', { sdp: 'x', type: 'offer' }).ok).toBe(true);
    expect(eventsFor(CALLEE)).toContain('call:offer');
    expect(eventsFor('intruder')).toHaveLength(0);
    expect(service.relay('intruder', ack.callId, 'call:offer', { sdp: 'x' }).ok).toBe(false);
  });

  it('met fin à l’appel après la grâce de déconnexion, sauf reconnexion', async () => {
    const ack = await service.invite(CALLER, 'conv-1');
    if (!ack.ok) throw new Error('invite failed');
    service.accept(CALLEE, ack.callId);

    service.handleUserOffline(CALLER);
    vi.advanceTimersByTime(CALL_DISCONNECT_GRACE_MS / 2);
    service.handleUserOnline(CALLER);
    vi.advanceTimersByTime(CALL_DISCONNECT_GRACE_MS);
    expect(emitted.find((e) => e.event === 'call:ended')).toBeUndefined();

    service.handleUserOffline(CALLER);
    vi.advanceTimersByTime(CALL_DISCONNECT_GRACE_MS);
    expect(emitted.find((e) => e.event === 'call:ended')?.payload.reason).toBe('disconnected');
  });
});
