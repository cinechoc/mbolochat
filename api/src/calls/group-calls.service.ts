import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { userRoomOf } from '../chat/socket-auth.js';
import { SocketRateLimiter } from '../chat/socket-rate-limit.js';
import {
  ConversationEventsService,
  type ConversationChange,
} from '../conversations/conversation-events.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import type { ConversationSummary } from '../conversations/conversations.service.js';
import { MediaService } from '../media/media.service.js';
import { CallsService } from './calls.service.js';
import { UsersService } from '../users/users.service.js';
import { canSee } from '../users/visibility.js';
import {
  CallLimits,
  GROUP_CALL_DISCONNECT_GRACE_MS,
  GROUP_CALL_EXPIRE_MS,
  type CallMedia,
} from './call-limits.js';
import type {
  GroupCallAck,
  GroupCallEndedPayload,
  GroupCallIdentity,
  GroupCallInvitePayload,
  GroupCallMember,
  GroupCallSignalPayload,
} from './calls.types.js';

function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

interface GroupCallParticipant extends GroupCallMember {
  joinedAt: number;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface GroupCallSession {
  id: string;
  group: GroupCallIdentity;
  /** Tous les membres du groupe : le bandeau d'appel doit s'éteindre chez eux aussi. */
  audienceIds: string[];
  initiatorId: string;
  initiatorName: string;
  media: CallMedia;
  participants: Map<string, GroupCallParticipant>;
  /** Membres qui ont déjà refusé : on ne les relance plus. */
  declined: Set<string>;
  createdAt: number;
  /** Instaurant dès le second participant : base du message de fin. */
  answeredAt: number | null;
}

/**
 * Appels vocaux et vidéo de groupe en maillage : la signalisation relaie
 * offer/answer/ICE d'un participant à l'autre, le média reste direct entre les
 * appareils. L'appel vit tant qu'il reste au moins un participant.
 *
 * Maillage = coût montant linéaire (une piste vidéo par lien) ; le plafond de
 * caméras (CALL_MAX_VIDEO) est la limite assumée du produit. Dépasser cette
 * limite demandera un serveur de relais média (SFU) : étape suivante, pas
 * maintenant.
 */
@Injectable()
export class GroupCallsService implements OnModuleDestroy {
  private server: Server | null = null;
  private readonly calls = new Map<string, GroupCallSession>();
  private readonly byConversation = new Map<string, string>();
  private readonly byUser = new Map<string, string>();
  private readonly expireTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly membershipSubscription: { unsubscribe: () => void } | null = null;

  constructor(
    private readonly conversations: ConversationsService,
    private readonly media: MediaService,
    private readonly rateLimiter: SocketRateLimiter,
    private readonly directCalls: CallsService,
    private readonly limits: CallLimits,
    private readonly events: ConversationEventsService,
    private readonly users: UsersService,
  ) {
    // Retiré du groupe, retiré de l'appel : sinon il continuerait à entendre.
    this.membershipSubscription = this.events.changes$.subscribe((change: ConversationChange) => {
      if (change.kind !== 'members' || change.action !== 'removed') {
        return;
      }
      for (const userId of change.userIds) {
        const call = this.callOfUser(userId);
        if (call && call.group.conversationId === change.conversationId) {
          this.remove(call, userId, 'left');
        }
      }
    });
  }

  attach(server: Server): void {
    this.server = server;
  }

  onModuleDestroy(): void {
    this.membershipSubscription?.unsubscribe();
    for (const timer of this.expireTimers.values()) {
      clearTimeout(timer);
    }
    this.expireTimers.clear();
    for (const call of this.calls.values()) {
      for (const participant of call.participants.values()) {
        if (participant.disconnectTimer) {
          clearTimeout(participant.disconnectTimer);
        }
      }
    }
    this.calls.clear();
    this.byConversation.clear();
    this.byUser.clear();
  }

  /** Lancer un appel, ou rejoindre celui déjà ouvert dans ce groupe. */
  async start(
    userId: string,
    conversationId: string | undefined,
    media: CallMedia = 'AUDIO',
  ): Promise<GroupCallAck> {
    if (!conversationId) {
      return { ok: false, error: 'invalid' };
    }
    if (!this.rateLimiter.allowCall(userId)) {
      return { ok: false, error: 'rate' };
    }
    if (this.directCalls.isBusy(userId)) {
      return { ok: false, error: 'busy' };
    }

    const existing = this.byUser.get(userId);
    if (existing) {
      const call = this.calls.get(existing);
      if (!call) {
        this.byUser.delete(userId);
      } else if (call.group.conversationId !== conversationId) {
        return { ok: false, error: 'busy' };
      } else {
        return this.ack(call);
      }
    }

    const [summary] = await this.conversations.listForUser(userId, conversationId);
    if (!summary || summary.type !== 'GROUP') {
      return { ok: false, error: 'invalid' };
    }

    // Deux appuis simultanés : le second a pu ouvrir la salle pendant notre
    // attente. On revérifie ici, sans suspension jusqu'à l'enregistrement, donc
    // une seule salle peut être créée par conversation.
    const open = this.openCallFor(conversationId);
    if (open) {
      return this.addParticipant(open, userId, summary);
    }
    return this.createCall(userId, summary, media);
  }

  /** Refuser une invitation : l'appel continue pour les autres. */
  decline(userId: string, callId: string | undefined): { ok: boolean } {
    const call = callId ? this.calls.get(callId) : null;
    if (!call || call.participants.has(userId)) {
      return { ok: false };
    }
    call.declined.add(userId);
    return { ok: true };
  }

  /** Relancer des membres du groupe depuis l'écran d'appel. */
  async add(
    userId: string,
    callId: string | undefined,
    targets: string[],
  ): Promise<{ ok: boolean; error?: 'invalid' | 'forbidden' }> {
    const call = callId ? this.calls.get(callId) : null;
    if (!call || !call.participants.has(userId)) {
      return { ok: false, error: 'invalid' };
    }
    let memberIds: Set<string>;
    try {
      const summary = await this.conversations.getSummaryForUser(
        call.group.conversationId,
        userId,
      );
      memberIds = new Set(summary.members.map((member) => member.id));
    } catch {
      return { ok: false, error: 'invalid' };
    }

    const invite = (targets ?? []).filter(
      (id) => memberIds.has(id) && !call.participants.has(id),
    );
    if (invite.length === 0) {
      return { ok: true };
    }
    // Une invitation volontaire efface les refus précédents de ces membres.
    for (const id of invite) {
      call.declined.delete(id);
    }
    await this.ring(call, userId, invite);
    return { ok: true };
  }
  /** Un administrateur peut sortir quelqu'un de l'appel sans le couper. */
  async kick(
    adminId: string,
    callId: string | undefined,
    userId: string,
  ): Promise<{ ok: boolean; error?: 'invalid' | 'forbidden' }> {
    const call = callId ? this.calls.get(callId) : null;
    if (!call || !call.participants.has(adminId) || !call.participants.has(userId)) {
      return { ok: false, error: 'invalid' };
    }
    const role = await this.conversations.roleOf(call.group.conversationId, adminId);
    if (role !== 'admin') {
      return { ok: false, error: 'forbidden' };
    }
    this.remove(call, userId, 'kicked');
    return { ok: true };
  }

  /** Passage en vidéo (ou retour à l'audio) pour tout l'appel. */
  setMedia(
    userId: string,
    callId: string | undefined,
    media: CallMedia,
  ): { ok: boolean; error?: 'invalid' | 'full' } {
    const call = callId ? this.calls.get(callId) : null;
    if (!call || !call.participants.has(userId)) {
      return { ok: false, error: 'invalid' };
    }
    if (media === 'VIDEO' && call.participants.size > this.limits.maxParticipants('VIDEO')) {
      return { ok: false, error: 'full' };
    }
    call.media = media;
    this.broadcast(call, 'gcall:media', {
      callId: call.id,
      media,
      maxParticipants: this.limits.maxParticipants(media),
      maxVideoParticipants: this.limits.maxVideoParticipants(),
    });
    return { ok: true };
  }

  /**
   * Caméra personnelle allumée/coupée : les tuiles des autres s'en informent.
   * Le plafond de caméras est arbitré ici, pas seulement dans l'interface :
   * au-delà de CALL_MAX_VIDEO, l'appel continue en audio et le client revient
   * à son état précédent.
   */
  setVideo(
    userId: string,
    callId: string | undefined,
    video: boolean,
  ): { ok: boolean; error?: 'invalid' | 'full' } {
    const call = callId ? this.calls.get(callId) : this.callOfUser(userId);
    const participant = call?.participants.get(userId);
    if (!call || !participant) {
      return { ok: false, error: 'invalid' };
    }
    if (video && !participant.video) {
      const cameras = [...call.participants.values()].filter((entry) => entry.video).length;
      if (cameras >= this.limits.maxVideoParticipants()) {
        return { ok: false, error: 'full' };
      }
    }
    participant.video = video;
    this.broadcast(call, 'gcall:video', { callId: call.id, userId, video });
    return { ok: true };
  }

  handleUserOffline(userId: string): void {
    const call = this.callOfUser(userId);
    if (!call) {
      return;
    }
    const participant = call.participants.get(userId);
    if (!participant || participant.disconnectTimer) {
      return;
    }
    participant.disconnectTimer = setTimeout(() => {
      participant.disconnectTimer = null;
      this.remove(call, userId, 'left');
    }, GROUP_CALL_DISCONNECT_GRACE_MS);
  }

  handleUserOnline(userId: string): void {
    const call = this.callOfUser(userId);
    const participant = call?.participants.get(userId);
    if (participant?.disconnectTimer) {
      clearTimeout(participant.disconnectTimer);
      participant.disconnectTimer = null;
    }
  }

  /** Reconnexion : le bandeau d'invitation encore valable revient chez les absents. */
  resendInvite(userId: string): void {
    for (const call of this.calls.values()) {
      if (call.participants.has(userId) || !call.audienceIds.includes(userId)) {
        continue;
      }
      this.emitToUser(userId, 'gcall:incoming', this.invitePayload(call));
    }
  }

  /** Relaie une offer/answer/ICE vers un participant précis du maillage. */
  relay(
    userId: string,
    callId: string | undefined,
    event: 'gcall:offer' | 'gcall:answer' | 'gcall:ice',
    payload: GroupCallSignalPayload,
  ): { ok: boolean } {
    const call = callId ? this.calls.get(callId) : null;
    if (!call || !payload?.to) {
      return { ok: false };
    }
    if (!call.participants.has(userId) || !call.participants.has(payload.to)) {
      return { ok: false };
    }
    if (event !== 'gcall:ice' && !payload.sdp) {
      return { ok: false };
    }
    if (event === 'gcall:ice' && payload.candidate === undefined) {
      return { ok: false };
    }
    this.emitToUser(payload.to, event, {
      callId: call.id,
      from: userId,
      ...(event === 'gcall:ice' ? { candidate: payload.candidate } : { sdp: payload.sdp }),
    });
    return { ok: true };
  }

  setMute(userId: string, callId: string | undefined, muted: boolean): { ok: boolean } {
    const call = callId ? this.calls.get(callId) : null;
    const participant = call?.participants.get(userId);
    if (!call || !participant) {
      return { ok: false };
    }
    participant.muted = muted;
    this.broadcast(call, 'gcall:mute', { callId: call.id, userId, muted });
    return { ok: true };
  }

  leave(userId: string, callId: string | undefined): { ok: boolean } {
    const call = callId ? this.calls.get(callId) : this.callOfUser(userId);
    if (!call || !call.participants.has(userId)) {
      return { ok: false };
    }
    this.remove(call, userId, 'left');
    return { ok: true };
  }

  /** L'utilisateur est déjà dans un appel de groupe. */
  isInCall(userId: string): boolean {
    return this.callOfUser(userId) !== null;
  }

  /* ------------------------------- interne ------------------------------- */

  private async createCall(
    userId: string,
    summary: ConversationSummary,
    media: CallMedia,
  ): Promise<GroupCallAck> {
    const member = summary.members.find((entry) => entry.id === userId);
    const participant = this.participant(userId, member?.displayName, member?.avatarUrl);
    const call: GroupCallSession = {
      id: randomUUID(),
      group: this.identityOf(summary),
      audienceIds: summary.members.map((entry) => entry.id),
      initiatorId: userId,
      initiatorName: participant.displayName,
      media,
      participants: new Map([[userId, participant]]),
      declined: new Set(),
      createdAt: Date.now(),
      answeredAt: null,
    };
    this.calls.set(call.id, call);
    this.byConversation.set(call.group.conversationId, call.id);
    this.byUser.set(userId, call.id);
    this.armExpiry(call);
    await this.ring(call, userId, call.audienceIds.filter((id) => id !== userId));
    await this.notice(call, userId, 'Appel de groupe en cours');
    return this.ack(call);
  }

  /** Sonner chez les membres ciblés ; les occupés reçoivent une simple notification. */
  private async ring(
    call: GroupCallSession,
    fromUserId: string,
    targets: string[],
  ): Promise<void> {
    const payload = this.invitePayload(call);
    // Qui peut m'appeler : le réglage de chaque personne ciblée s'applique.
    const relations = await this.users.relationsFor(fromUserId, targets);
    const people = new Map(
      (await this.users.findManyByIds(targets)).map((person) => [person.id, person]),
    );
    for (const target of targets) {
      if (target === fromUserId || call.declined.has(target)) {
        continue;
      }
      const person = people.get(target);
      if (
        person &&
        !canSee(person.callPermission, relations.get(target) ?? { isContact: false, blocked: false })
      ) {
        continue;
      }
      if (this.isBusySomewhere(target)) {
        this.emitToUser(target, 'gcall:busy', {
          callId: call.id,
          ...call.group,
          from: { id: fromUserId, displayName: call.participants.get(fromUserId)?.displayName ?? 'Quelqu’un' },
        });
        continue;
      }
      this.emitToUser(target, 'gcall:incoming', payload);
    }
  }

  private isBusySomewhere(userId: string): boolean {
    return this.directCalls.isBusy(userId) || this.byUser.has(userId);
  }

  private invitePayload(call: GroupCallSession): GroupCallInvitePayload {
    return {
      callId: call.id,
      ...call.group,
      from: { id: call.initiatorId, displayName: call.initiatorName },
      members: this.membersOf(call),
      media: call.media,
      maxParticipants: this.limits.maxParticipants(call.media),
      maxVideoParticipants: this.limits.maxVideoParticipants(),
    };
  }

  /** Un membre déjà dans l'appel, ou qui le rejoint en cours de route. */
  private addParticipant(
    call: GroupCallSession,
    userId: string,
    summary: ConversationSummary,
  ): GroupCallAck {
    if (call.participants.has(userId)) {
      return this.ack(call);
    }
    const member = summary.members.find((entry) => entry.id === userId);
    if (!member) {
      return { ok: false, error: 'invalid' };
    }
    const max = this.limits.maxParticipants(call.media);
    if (call.participants.size >= max) {
      return { ok: false, error: 'full' };
    }
    const participant = this.participant(userId, member.displayName, member.avatarUrl);
    call.participants.set(userId, participant);
    call.declined.delete(userId);
    this.byUser.set(userId, call.id);
    this.clearExpiry(call);
    if (call.participants.size === 2) {
      call.answeredAt = Date.now();
    }
    // Le nouvel arrivant déclare les liens ; les présents attendent son offer.
    for (const other of call.participants.values()) {
      if (other.id === userId) {
        continue;
      }
      this.emitToUser(other.id, 'gcall:joined', { callId: call.id, peer: { ...participant } });
    }
    return this.ack(call);
  }

  /** Retrait d'un participant : `left` pour lui, `kicked` s'il a été exclu. */
  private remove(call: GroupCallSession, userId: string, reason: 'left' | 'kicked'): void {
    const participant = call.participants.get(userId);
    if (!participant) {
      return;
    }
    if (participant.disconnectTimer) {
      clearTimeout(participant.disconnectTimer);
      participant.disconnectTimer = null;
    }
    call.participants.delete(userId);
    this.byUser.delete(userId);
    this.emitToUser(userId, `gcall:${reason}`, { callId: call.id, userId });
    this.broadcast(call, 'gcall:peer-left', { callId: call.id, userId });
    if (call.participants.size === 0) {
      this.close(call);
    } else if (call.participants.size === 1) {
      this.armExpiry(call);
    }
  }

  private participant(
    userId: string,
    displayName: string | undefined,
    avatarUrl: string | null | undefined,
  ): GroupCallParticipant {
    return {
      id: userId,
      displayName: displayName ?? 'Quelqu’un',
      avatarUrl: this.media.signOrNull(avatarUrl),
      muted: false,
      video: false,
      joinedAt: Date.now(),
      disconnectTimer: null,
    };
  }

  private identityOf(summary: ConversationSummary): GroupCallIdentity {
    return {
      conversationId: summary.id,
      name: summary.name?.trim() || 'Groupe',
      emoji: summary.emoji,
      color: summary.color,
      avatarUrl: this.media.signOrNull(summary.avatarUrl),
    };
  }

  private membersOf(call: GroupCallSession): GroupCallMember[] {
    return [...call.participants.values()].map(({ id, displayName, avatarUrl, muted, video }) => ({
      id,
      displayName,
      avatarUrl,
      muted,
      video,
    }));
  }

  private ack(call: GroupCallSession): GroupCallAck {
    return {
      ok: true,
      callId: call.id,
      group: call.group,
      members: this.membersOf(call),
      media: call.media,
      maxParticipants: this.limits.maxParticipants(call.media),
      maxVideoParticipants: this.limits.maxVideoParticipants(),
    };
  }

  private callOfUser(userId: string): GroupCallSession | null {
    const callId = this.byUser.get(userId);
    return callId ? (this.calls.get(callId) ?? null) : null;
  }

  private openCallFor(conversationId: string): GroupCallSession | null {
    const callId = this.byConversation.get(conversationId);
    return callId ? (this.calls.get(callId) ?? null) : null;
  }

  /** Deux minutes sans second participant : l'appel n'a pas eu lieu. */
  private armExpiry(call: GroupCallSession): void {
    this.clearExpiry(call);
    this.expireTimers.set(
      call.id,
      setTimeout(() => {
        this.expireTimers.delete(call.id);
        const current = this.calls.get(call.id);
        if (current && current.participants.size < 2) {
          this.close(current);
        }
      }, GROUP_CALL_EXPIRE_MS),
    );
  }

  private clearExpiry(call: GroupCallSession): void {
    const timer = this.expireTimers.get(call.id);
    if (timer) {
      clearTimeout(timer);
      this.expireTimers.delete(call.id);
    }
  }

  private close(call: GroupCallSession): void {
    this.clearExpiry(call);
    const durationMs = call.answeredAt ? Date.now() - call.answeredAt : 0;
    const payload: GroupCallEndedPayload = {
      callId: call.id,
      conversationId: call.group.conversationId,
    };
    for (const userId of call.audienceIds) {
      this.emitToUser(userId, 'gcall:ended', payload);
    }
    for (const participant of call.participants.values()) {
      if (participant.disconnectTimer) {
        clearTimeout(participant.disconnectTimer);
      }
      this.byUser.delete(participant.id);
    }
    this.byUser.delete(call.initiatorId);
    this.calls.delete(call.id);
    if (this.byConversation.get(call.group.conversationId) === call.id) {
      this.byConversation.delete(call.group.conversationId);
    }
    // Un appel qui n'a jamais relié deux personnes ne laisse pas de trace.
    if (call.answeredAt && durationMs >= 1_000) {
      void this.notice(
        call,
        call.initiatorId,
        `Appel terminé · ${formatCallDuration(durationMs)}`,
      );
    }
  }

  /** Message système dans le fil du groupe (ouverture, puis durée finale). */
  private async notice(call: GroupCallSession, actorId: string, content: string): Promise<void> {
    try {
      await this.conversations.postSystemMessage(call.group.conversationId, actorId, content);
    } catch {
      // L'appel continue : la trace écrite n'est pas critique.
    }
  }

  private broadcast(call: GroupCallSession, event: string, payload: unknown): void {
    const exceptId = (payload as { userId?: string }).userId;
    for (const participant of call.participants.values()) {
      if (participant.id !== exceptId) {
        this.emitToUser(participant.id, event, payload);
      }
    }
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(userRoomOf(userId)).emit(event, payload);
  }
}
