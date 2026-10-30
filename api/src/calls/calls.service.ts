import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { ConversationsService } from '../conversations/conversations.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { PushService } from '../push/push.service.js';
import { UsersService } from '../users/users.service.js';
import { SocketRateLimiter } from '../chat/socket-rate-limit.js';
import { userRoomOf } from '../chat/socket-auth.js';
import type { CallEndedPayload, CallInviteAck, CallOutcome, CallPeer } from './calls.types.js';

export const CALL_RING_TIMEOUT_MS = 30_000;
export const CALL_DISCONNECT_GRACE_MS = 10_000;

const conversationRoomOf = (conversationId: string) => `conv:${conversationId}`;

function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function callNoticeText(outcome: CallOutcome, durationMs: number, video: boolean): string {
  const kind = video ? 'Appel vidéo' : 'Appel vocal';
  switch (outcome) {
    case 'completed':
      return `${kind} · ${formatCallDuration(durationMs)}`;
    case 'declined':
      return video ? 'Appel vidéo refusé' : 'Appel refusé';
    case 'cancelled':
      return video ? 'Appel vidéo annulé' : 'Appel annulé';
    default:
      return video ? 'Appel vidéo manqué' : 'Appel manqué';
  }
}

type CallEndReason = 'hangup' | 'timeout' | 'disconnected' | 'error';

interface CallSession {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  /** Identité de l'appelant, renvoyée à l'appelé à chaque reconnexion. */
  caller: CallPeer;
  status: 'ringing' | 'active';
  /** Une caméra a été utilisée à un moment de l'appel (titre du message final). */
  video: boolean;
  createdAt: number;
  answeredAt: number | null;
  /** Le message système n'est écrit qu'une fois, quelle que soit la sortie. */
  noticeSent: boolean;
  /** Une notification plein écran a été poussée : il faudra l'annuler. */
  pushNotified: boolean;
  ringTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * État des appels vocaux en mémoire (serveur mono-instance).
 * Les events passent par le salon personnel `user:<id>` du gateway Socket.IO.
 */
@Injectable()
export class CallsService implements OnModuleDestroy {
  private server: Server | null = null;
  private readonly calls = new Map<string, CallSession>();
  /** Appel en cours (sonnerie ou actif) par utilisateur : un seul à la fois. */
  private readonly callByUser = new Map<string, string>();

  constructor(
    private readonly conversations: ConversationsService,
    private readonly users: UsersService,
    private readonly push: PushService,
    private readonly presence: PresenceService,
    private readonly rateLimiter: SocketRateLimiter,
  ) {}

  /** Le gateway fournit le serveur Socket.IO une fois initialisé. */
  attach(server: Server): void {
    this.server = server;
  }

  onModuleDestroy(): void {
    for (const call of this.calls.values()) {
      this.clearTimers(call);
    }
    this.calls.clear();
    this.callByUser.clear();
  }

  /** Un appel 1:1 est déjà en cours pour cet utilisateur. */
  isBusy(userId: string): boolean {
    return this.callByUser.has(userId);
  }

  async invite(
    callerId: string,
    conversationId: string | undefined,
    video = false,
  ): Promise<CallInviteAck> {
    if (!conversationId) {
      return { ok: false, error: 'invalid' };
    }
    if (!this.rateLimiter.allowCall(callerId)) {
      return { ok: false, error: 'rate' };
    }

    // La conversation valide aussi l'appartenance de l'appelant.
    const [summary] = await this.conversations.listForUser(callerId, conversationId);
    if (!summary || summary.type !== 'DIRECT' || summary.members.length !== 2) {
      return { ok: false, error: 'invalid' };
    }
    const callee = summary.members.find((member) => member.id !== callerId);
    if (!callee) {
      return { ok: false, error: 'invalid' };
    }

    // Un appel à la fois par personne, dans les deux sens.
    if (this.callByUser.has(callerId) || this.callByUser.has(callee.id)) {
      return { ok: false, error: 'busy' };
    }
    if (await this.users.isBlockedBetween(callerId, callee.id)) {
      return { ok: false, error: 'unavailable' };
    }

    const caller = summary.members.find((member) => member.id === callerId);
    const from: CallPeer = {
      id: callerId,
      displayName: caller?.displayName ?? 'Quelqu’un',
      avatarUrl: caller?.avatarUrl ?? null,
    };

    const call: CallSession = {
      id: randomUUID(),
      conversationId,
      callerId,
      calleeId: callee.id,
      caller: from,
      status: 'ringing',
      video,
      createdAt: Date.now(),
      answeredAt: null,
      noticeSent: false,
      pushNotified: false,
      ringTimer: null,
      disconnectTimer: null,
    };
    call.ringTimer = setTimeout(() => this.timeout(call.id), CALL_RING_TIMEOUT_MS);
    this.calls.set(call.id, call);
    this.callByUser.set(callerId, call.id);
    this.callByUser.set(callee.id, call.id);

    this.emitToUser(callee.id, 'call:incoming', {
      callId: call.id,
      conversationId,
      from,
      video,
      createdAt: new Date(call.createdAt).toISOString(),
    });
    this.emitToUser(callerId, 'call:ringing', { callId: call.id, calleeId: callee.id });

    // App en arrière-plan ou fermée : notification plein écran. Un appareil
    // au premier plan reçoit déjà l'événement Socket.IO.
    const calleeOnline = this.presence.isOnline(callee.id);
    if (!calleeOnline) {
      call.pushNotified = true;
      void this.push.notifyIncomingCall({
        callId: call.id,
        conversationId,
        calleeId: callee.id,
        callerName: from.displayName,
        callerAvatarUrl: from.avatarUrl,
        video: call.video,
      });
    }

    return {
      ok: true,
      callId: call.id,
      peer: { id: callee.id, displayName: callee.displayName, avatarUrl: callee.avatarUrl ?? null },
    };
  }

  accept(userId: string, callId: string | undefined, video = false): { ok: boolean } {
    const call = this.getCall(callId);
    if (!call || call.calleeId !== userId || call.status !== 'ringing') {
      return { ok: false };
    }
    call.status = 'active';
    call.answeredAt = Date.now();
    call.video = call.video || video;
    this.clearRingTimer(call);
    this.emitToUser(call.callerId, 'call:accepted', { callId: call.id, video });
    this.emitToUser(call.calleeId, 'call:accepted', { callId: call.id, video });
    // Les autres appareils de l'appelé ferment leur notification plein écran.
    this.notifyCallUpdate(call, 'cancelled');
    return { ok: true };
  }

  /** Caméra locale activée/coupée : on prévient l'autre et on retient le type. */
  toggleVideo(userId: string, callId: string | undefined, video: boolean): { ok: boolean } {
    const call = this.getCall(callId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) {
      return { ok: false };
    }
    if (video) {
      call.video = true;
    }
    const otherId = call.callerId === userId ? call.calleeId : call.callerId;
    this.emitToUser(otherId, 'call:video-toggle', { callId: call.id, video });
    return { ok: true };
  }

  reject(userId: string, callId: string | undefined, reason: 'declined' | 'busy' = 'declined'): { ok: boolean } {
    const call = this.getCall(callId);
    if (!call || call.calleeId !== userId) {
      return { ok: false };
    }
    this.emitToUser(call.callerId, 'call:rejected', { callId: call.id, reason });
    this.notifyCallUpdate(call, 'cancelled');
    this.finish(call, 'hangup', false, 'declined');
    return { ok: true };
  }

  cancel(userId: string, callId: string | undefined): { ok: boolean } {
    const call = this.getCall(callId);
    if (!call || call.callerId !== userId) {
      return { ok: false };
    }
    this.emitToUser(call.calleeId, 'call:cancelled', { callId: call.id });
    this.notifyCallUpdate(call, 'cancelled');
    this.finish(call, 'hangup', false, 'cancelled');
    return { ok: true };
  }

  end(userId: string, callId: string | undefined): { ok: boolean } {
    const call = this.getCall(callId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) {
      return { ok: false };
    }
    if (!call.answeredAt) {
      this.notifyCallUpdate(call, 'cancelled');
    }
    this.finish(call, 'hangup', true, call.answeredAt ? 'completed' : 'cancelled');
    return { ok: true };
  }

  /** Relaie offer/answer/ice à l'autre participant de l'appel. */
  relay(
    userId: string,
    callId: string | undefined,
    event: 'call:offer' | 'call:answer' | 'call:ice',
    payload: unknown,
  ): { ok: boolean } {
    const call = this.getCall(callId);
    if (!call) {
      return { ok: false };
    }
    const otherId =
      call.callerId === userId ? call.calleeId : call.calleeId === userId ? call.callerId : null;
    if (!otherId) {
      return { ok: false };
    }
    this.emitToUser(otherId, event, { ...(payload as object), callId: call.id });
    return { ok: true };
  }

  handleUserOffline(userId: string): void {
    const callId = this.callByUser.get(userId);
    if (!callId) {
      return;
    }
    const call = this.calls.get(callId);
    if (!call || call.disconnectTimer) {
      return;
    }
    call.disconnectTimer = setTimeout(() => {
      call.disconnectTimer = null;
      if (!call.answeredAt) {
        this.notifyCallUpdate(call, 'missed');
      }
      this.finish(call, 'disconnected', true, call.answeredAt ? 'completed' : 'missed');
    }, CALL_DISCONNECT_GRACE_MS);
  }

  handleUserOnline(userId: string): void {
    const callId = this.callByUser.get(userId);
    const call = callId ? this.calls.get(callId) : null;
    if (call?.disconnectTimer) {
      clearTimeout(call.disconnectTimer);
      call.disconnectTimer = null;
    }
  }

  /**
   * Reconnexion de l'appelé pendant la sonnerie (app rouverte depuis la
   * notification plein écran) : on lui renvoie l'invitation encore valide.
   */
  resendIncoming(userId: string): void {
    const callId = this.callByUser.get(userId);
    const call = callId ? this.calls.get(callId) : null;
    if (!call || call.status !== 'ringing' || call.calleeId !== userId) {
      return;
    }
    this.emitToUser(call.calleeId, 'call:incoming', {
      callId: call.id,
      conversationId: call.conversationId,
      from: call.caller,
      video: call.video,
      createdAt: new Date(call.createdAt).toISOString(),
    });
  }

  /* ------------------------------- interne ------------------------------- */

  private getCall(callId: string | undefined): CallSession | null {
    return callId ? (this.calls.get(callId) ?? null) : null;
  }

  private timeout(callId: string): void {
    const call = this.calls.get(callId);
    if (!call || call.status !== 'ringing') {
      return;
    }
    this.emitToUser(call.calleeId, 'call:missed', { callId: call.id });
    this.notifyCallUpdate(call, 'missed');
    this.finish(call, 'timeout', true, 'missed');
  }

  /** Termine l'appel, prévient les deux participants puis nettoie l'état. */
  private finish(
    call: CallSession,
    reason: CallEndReason,
    notifyCaller: boolean,
    outcome: CallOutcome,
  ): void {
    const durationMs = call.answeredAt ? Date.now() - call.answeredAt : 0;
    // Un décroché suivi d'une chute immédiate n'est pas un appel « abouti ».
    const effectiveOutcome: CallOutcome =
      outcome === 'completed' && durationMs < 1_000 ? 'cancelled' : outcome;
    const payload: CallEndedPayload = {
      callId: call.id,
      reason,
      durationMs,
      outcome: effectiveOutcome,
    };
    if (notifyCaller) {
      this.emitToUser(call.callerId, 'call:ended', payload);
    }
    this.emitToUser(call.calleeId, 'call:ended', payload);
    this.clearTimers(call);
    this.calls.delete(call.id);
    this.callByUser.delete(call.callerId);
    if (this.callByUser.get(call.calleeId) === call.id) {
      this.callByUser.delete(call.calleeId);
    }
    if (this.callByUser.get(call.callerId) === call.id) {
      this.callByUser.delete(call.callerId);
    }
    // Le message système suit l'événement de fin : l'UI d'appel se ferme tout
    // de suite, la pastille apparaît dans le fil dès l'écriture.
    void this.recordNotice(call, effectiveOutcome, durationMs);
  }

  /** Message système « Appel vocal · 1:24 » / « Appel manqué »…, une seule fois. */
  private async recordNotice(
    call: CallSession,
    outcome: CallOutcome,
    durationMs: number,
  ): Promise<void> {
    if (call.noticeSent) {
      return;
    }
    call.noticeSent = true;
    try {
      const message = await this.conversations.createCallMessage(
        call.conversationId,
        call.callerId,
        callNoticeText(outcome, durationMs, call.video),
      );
      if (!this.server) {
        return;
      }
      const memberIds = await this.conversations.listMemberIds(call.conversationId);
      let broadcast = this.server.to(conversationRoomOf(call.conversationId));
      for (const memberId of memberIds) {
        broadcast = broadcast.to(userRoomOf(memberId));
      }
      broadcast.emit('message:new', message);
    } catch {
      // L'appel est terminé : un échec d'écriture ne doit pas le relancer.
    }
  }

  /** Ferme (ou remplace par « manqué ») la notification plein écran distante. */
  private notifyCallUpdate(call: CallSession, outcome: 'cancelled' | 'missed'): void {
    if (!call.pushNotified) {
      return;
    }
    void this.push.notifyCallUpdate({
      calleeId: call.calleeId,
      callId: call.id,
      conversationId: call.conversationId,
      callerName: call.caller.displayName,
      video: call.video,
      outcome,
    });
  }

  private clearRingTimer(call: CallSession): void {
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = null;
    }
  }

  private clearTimers(call: CallSession): void {
    this.clearRingTimer(call);
    if (call.disconnectTimer) {
      clearTimeout(call.disconnectTimer);
      call.disconnectTimer = null;
    }
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(userRoomOf(userId)).emit(event, payload);
  }
}
