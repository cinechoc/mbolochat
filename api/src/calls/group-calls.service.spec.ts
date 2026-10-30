import { Subject } from 'rxjs';
import type { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationChange } from '../conversations/conversation-events.service.js';
import type { ConversationEventsService } from '../conversations/conversation-events.service.js';
import type { ConversationSummary } from '../conversations/conversations.service.js';
import type { ConversationsService } from '../conversations/conversations.service.js';
import type { SocketRateLimiter } from '../chat/socket-rate-limit.js';
import type { MediaService } from '../media/media.service.js';
import type { CallLimits } from './call-limits.js';
import type { CallsService } from './calls.service.js';
import { GroupCallsService } from './group-calls.service.js';

const GROUP = 'group-1';
const IDS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'];

type Emitted = { room: string; event: string; payload: any };

function groupSummary(): ConversationSummary[] {
  return [
    {
      id: GROUP,
      type: 'GROUP',
      name: 'Équipe',
      emoji: null,
      color: null,
      avatarUrl: null,
      members: IDS.map((id) => ({ id, displayName: id.toUpperCase(), avatarUrl: null })),
    } as unknown as ConversationSummary,
  ];
}

describe('GroupCallsService', () => {
  let emitted: Emitted[];
  let notices: string[];
  let conversations: {
    listForUser: ReturnType<typeof vi.fn>;
    getSummaryForUser: ReturnType<typeof vi.fn>;
    postSystemMessage: ReturnType<typeof vi.fn>;
    roleOf: ReturnType<typeof vi.fn>;
  };
  let media: { signOrNull: ReturnType<typeof vi.fn> };
  let limiter: { allowCall: ReturnType<typeof vi.fn> };
  let direct: { isBusy: ReturnType<typeof vi.fn> };
  let limits: { maxParticipants: ReturnType<typeof vi.fn> };
  let bus: Subject<ConversationChange>;
  let service: GroupCallsService;

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

  function eventsOf(event: string): Emitted[] {
    return emitted.filter((entry) => entry.event === event);
  }

  function events(event: string): Emitted[] {
    return emitted.filter((entry) => entry.event === event);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    notices = [];
    conversations = {
      listForUser: vi.fn().mockImplementation((_userId: string, conversationId: string) =>
        Promise.resolve(conversationId === GROUP ? groupSummary() : []),
      ),
      getSummaryForUser: vi.fn().mockResolvedValue(groupSummary()[0]),
      postSystemMessage: vi.fn().mockImplementation((_cid: string, _actor: string, content: string) => {
        notices.push(content);
        return Promise.resolve({ id: 'system-1', content });
      }),
      roleOf: vi.fn().mockImplementation((_conversationId: string, userId: string) =>
        Promise.resolve(userId === 'u1' ? 'admin' : 'member'),
      ),
    };
    media = { signOrNull: vi.fn().mockImplementation((value) => value) };
    limiter = { allowCall: vi.fn().mockReturnValue(true) };
    direct = { isBusy: vi.fn().mockReturnValue(false) };
    limits = {
      maxParticipants: vi.fn().mockImplementation((m: string) => (m === 'VIDEO' ? 4 : 8)),
    };
    bus = new Subject<ConversationChange>();
    service = new GroupCallsService(
      conversations as unknown as ConversationsService,
      media as unknown as MediaService,
      limiter as unknown as SocketRateLimiter,
      direct as unknown as CallsService,
      limits as unknown as CallLimits,
      { changes$: bus } as unknown as ConversationEventsService,
    );
    service.attach({
      to: (room: string) => operator([room]),
    } as unknown as Server);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('ouvre l’appel, invite le groupe et laisse une trace écrite', async () => {
    const ack = await service.start('u1', GROUP);
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.members.map((member) => member.id)).toEqual(['u1']);
    expect(ack.media).toBe('AUDIO');
    expect(ack.maxParticipants).toBe(8);
    expect(events('gcall:incoming')).toHaveLength(IDS.length - 1);
    expect(notices).toEqual(['Appel de groupe en cours']);
  });

  it('refuse une discussion directe et un utilisateur déjà occupé', async () => {
    conversations.listForUser.mockResolvedValueOnce([
      { id: 'direct', type: 'DIRECT', members: [] } as unknown as ConversationSummary,
    ]);
    await expect(service.start('u1', 'direct')).resolves.toEqual({ ok: false, error: 'invalid' });

    await service.start('u1', GROUP);
    await expect(service.start('u9', 'other')).resolves.toEqual({ ok: false, error: 'invalid' });
    direct.isBusy.mockReturnValue(true);
    await expect(service.start('u3', GROUP)).resolves.toEqual({ ok: false, error: 'busy' });
  });

  it('prévient les présents et plafonne le maillage à huit en audio', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');

    const joined = await service.start('u2', GROUP);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.members.map((member) => member.id)).toEqual(['u1', 'u2']);
    expect(events('gcall:joined')).toHaveLength(1);

    for (const id of ['u3', 'u4', 'u5', 'u6', 'u7', 'u8']) {
      await service.start(id, GROUP);
    }
    await expect(service.start('u9', GROUP)).resolves.toEqual({ ok: false, error: 'full' });
  });

  it('relaie la signalisation uniquement entre participants', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');
    await service.start('u2', GROUP);

    expect(
      service.relay('u1', started.callId, 'gcall:offer', {
        callId: started.callId,
        to: 'u2',
        sdp: 'v=0',
      }),
    ).toEqual({ ok: true });
    expect(events('gcall:offer')[0]?.payload).toEqual({
      callId: started.callId,
      from: 'u1',
      sdp: 'v=0',
    });

    expect(
      service.relay('u1', started.callId, 'gcall:offer', {
        callId: started.callId,
        to: 'u3',
        sdp: 'v=0',
      }),
    ).toEqual({ ok: false });
    expect(
      service.relay('u1', started.callId, 'gcall:offer', { callId: started.callId, sdp: 'v=0' }),
    ).toEqual({ ok: false });
  });

  it('un refus individuel et un départ n’éteignent pas l’appel', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');
    await service.start('u2', GROUP);

    expect(service.decline('u3', started.callId)).toEqual({ ok: true });
    expect(service.leave('u2', started.callId)).toEqual({ ok: true });
    expect(events('gcall:peer-left')).toHaveLength(1);
    expect(notices).toHaveLength(1);

    // Personne n'est relancé tout seul : le bouton « Ajouter » le fait, lui.
    emitted = [];
    expect(await service.add('u1', started.callId, ['u2', 'u3', 'u4'])).toEqual({ ok: true });
    const rung = events('gcall:incoming').map((entry) => entry.room);
    expect(rung).toEqual(['user:u2', 'user:u3', 'user:u4']);
  });

  it('notifie simplement un membre déjà occupé', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');
    direct.isBusy.mockImplementation((id: string) => id === 'u2');
    emitted = [];
    expect(await service.add('u1', started.callId, ['u2'])).toEqual({ ok: true });
    expect(events('gcall:incoming')).toHaveLength(0);
    expect(events('gcall:busy')[0]?.payload.callId).toBe(started.callId);
  });

  it('l’administrateur exclut un participant, pas un simple membre', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');
    await service.start('u2', GROUP);
    await service.start('u3', GROUP);

    expect(await service.kick('u2', started.callId, 'u3')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.kick('u1', started.callId, 'u3')).toEqual({ ok: true });
    expect(events('gcall:kicked')[0]?.payload.userId).toBe('u3');
    expect(events('gcall:peer-left').map((entry) => entry.room)).toEqual(['user:u1', 'user:u2']);
  });

  it('bascule en vidéo seulement si le maillage le supporte', async () => {
    const started = await service.start('u1', GROUP, 'AUDIO');
    if (!started.ok) throw new Error('appel non ouvert');
    for (const id of ['u2', 'u3', 'u4', 'u5']) {
      await service.start(id, GROUP);
    }
    expect(service.setMedia('u1', started.callId, 'VIDEO')).toEqual({ ok: false, error: 'full' });
    service.leave('u5', started.callId);
    expect(service.setMedia('u1', started.callId, 'VIDEO')).toEqual({ ok: true });
    expect(events('gcall:media')[0]?.payload.media).toBe('VIDEO');
    expect(service.setVideo('u1', started.callId, true)).toEqual({ ok: true });
    expect(events('gcall:video')[0]?.payload).toEqual({
      callId: started.callId,
      userId: 'u1',
      video: true,
    });
  });

  it('propage le micro coupé et la durée finale à la fermeture', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');
    await service.start('u2', GROUP);
    vi.advanceTimersByTime(2_000);

    expect(service.setMute('u1', started.callId, true)).toEqual({ ok: true });
    expect(events('gcall:mute')[0]?.payload).toEqual({
      callId: started.callId,
      userId: 'u1',
      muted: true,
    });

    service.leave('u2', started.callId);
    service.leave('u1', started.callId);

    expect(notices[1]).toBe('Appel terminé · 0:02');
    expect(events('gcall:ended')).toHaveLength(IDS.length);
  });

  it('deux appuis simultanés tombent dans la même salle', async () => {
    // Les deux appels entrent en attente avant que la salle n'existe.
    conversations.listForUser.mockImplementation(async () => {
      await Promise.resolve();
      await Promise.resolve();
      return groupSummary();
    });
    const [first, second] = await Promise.all([
      service.start('u1', GROUP),
      service.start('u2', GROUP),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.callId).toBe(second.callId);
    expect(second.members.map((member) => member.id).sort()).toEqual(['u1', 'u2']);
  });

  it('retire de l’appel un membre exclu du groupe', async () => {
    const started = await service.start('u1', GROUP);
    if (!started.ok) throw new Error('appel non ouvert');
    await service.start('u2', GROUP);
    emitted = [];
    bus.next({
      kind: 'members',
      conversationId: GROUP,
      actorId: 'u1',
      action: 'removed',
      userIds: ['u2'],
    });
    expect(service.isInCall('u2')).toBe(false);
    expect(eventsOf('gcall:peer-left')).toHaveLength(1);
  });

  it('éteint un appel que personne ne rejoint, sans durée', async () => {
    const started = await service.start('u1', GROUP);
    expect(started.ok).toBe(true);
    vi.advanceTimersByTime(90_000);
    expect(notices).toEqual(['Appel de groupe en cours']);
    expect(events('gcall:ended')).toHaveLength(IDS.length);
  });
});
