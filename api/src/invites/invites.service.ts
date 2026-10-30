import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  conversationInvites,
  conversationJoinRequests,
  conversationMembers,
  conversations,
  users,
} from '../db/schema.js';
import { ConversationEventsService } from '../conversations/conversation-events.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { MAX_GROUP_MEMBERS } from '../conversations/group-limits.js';

export type InviteStatus = 'ok' | 'expired' | 'revoked' | 'exhausted' | 'full';

export interface InviteDto {
  id: string;
  token: string;
  conversationId: string;
  expiresAt: Date;
  maxUses: number | null;
  uses: number;
  requiresApproval: boolean;
  createdAt: Date;
  status: InviteStatus;
}

export interface InvitePreview {
  group: {
    id: string;
    name: string | null;
    description: string | null;
    emoji: string | null;
    color: string | null;
    avatarUrl: string | null;
    memberCount: number;
  };
  requiresApproval: boolean;
  expiresAt: Date;
  status: InviteStatus;
}

export interface JoinRequestDto {
  id: string;
  inviteId: string;
  createdAt: Date;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    gender: string | null;
  };
}

export interface JoinResult {
  status: 'joined' | 'pending' | 'rejected';
  conversationId: string;
  requestId?: string;
}

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly conversations: ConversationsService,
    private readonly events: ConversationEventsService,
  ) {}

  async create(
    conversationId: string,
    userId: string,
    input: { expiresInHours?: number; maxUses?: number; requiresApproval?: boolean },
  ): Promise<InviteDto> {
    await this.requireGroupMembership(conversationId, userId);

    const expiresInHours = input.expiresInHours ?? 168;
    const [invite] = await this.db
      .insert(conversationInvites)
      .values({
        conversationId,
        createdById: userId,
        token: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000),
        maxUses: input.maxUses ?? null,
        requiresApproval: Boolean(input.requiresApproval),
      })
      .returning();

    const memberCount = await this.memberCount(conversationId);
    return this.toDto(invite, memberCount);
  }

  async list(conversationId: string, userId: string): Promise<InviteDto[]> {
    await this.requireGroupMembership(conversationId, userId);
    const rows = await this.db
      .select()
      .from(conversationInvites)
      .where(eq(conversationInvites.conversationId, conversationId))
      .orderBy(asc(conversationInvites.createdAt));
    const memberCount = await this.memberCount(conversationId);
    return rows.map((row) => this.toDto(row, memberCount));
  }

  async revoke(conversationId: string, inviteId: string, userId: string): Promise<void> {
    const role = await this.conversations.roleOf(conversationId, userId);
    if (!role) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const [invite] = await this.db
      .select()
      .from(conversationInvites)
      .where(
        and(
          eq(conversationInvites.id, inviteId),
          eq(conversationInvites.conversationId, conversationId),
        ),
      )
      .limit(1);
    if (!invite) {
      throw new NotFoundException('Invitation introuvable');
    }
    if (invite.createdById !== userId && role !== 'admin') {
      throw new ForbiddenException('Seuls le créateur de l’invitation ou un admin peuvent la révoquer');
    }
    if (!invite.revokedAt) {
      await this.db
        .update(conversationInvites)
        .set({ revokedAt: new Date() })
        .where(eq(conversationInvites.id, inviteId));
    }
  }

  /** Aperçu public : aucune identité de membre, juste l'identité du groupe. */
  async preview(token: string): Promise<InvitePreview> {
    const row = await this.loadInvite(token);
    return {
      group: {
        id: row.conversation.id,
        name: row.conversation.name,
        description: row.conversation.description,
        emoji: row.conversation.emoji,
        color: row.conversation.color,
        avatarUrl: row.conversation.avatarUrl,
        memberCount: row.memberCount,
      },
      requiresApproval: row.invite.requiresApproval,
      expiresAt: row.invite.expiresAt,
      status: row.status,
    };
  }

  async join(token: string, userId: string): Promise<JoinResult> {
    const row = await this.loadInvite(token);
    const conversationId = row.conversation.id;

    if (await this.conversations.isMember(conversationId, userId)) {
      return { status: 'joined', conversationId };
    }
    if (row.status !== 'ok') {
      this.throwForStatus(row.status);
    }

    if (row.invite.requiresApproval) {
      const [request] = await this.db
        .insert(conversationJoinRequests)
        .values({
          conversationId,
          inviteId: row.invite.id,
          userId,
        })
        .onConflictDoUpdate({
          target: [conversationJoinRequests.inviteId, conversationJoinRequests.userId],
          set: { status: 'pending', createdAt: new Date(), resolvedAt: null, resolvedById: null },
        })
        .returning();
      return { status: 'pending', conversationId, requestId: request.id };
    }

    await this.addMemberWithinLimit(conversationId, userId);
    await this.db
      .update(conversationInvites)
      .set({ uses: sql`${conversationInvites.uses} + 1` })
      .where(eq(conversationInvites.id, row.invite.id));

    this.events.publish({
      kind: 'members',
      conversationId,
      actorId: userId,
      action: 'added',
      userIds: [userId],
    });
    await this.announceJoin(conversationId, userId);
    return { status: 'joined', conversationId };
  }

  async listJoinRequests(conversationId: string, userId: string): Promise<JoinRequestDto[]> {
    await this.requireAdmin(conversationId, userId);
    const rows = await this.db
      .select({
        id: conversationJoinRequests.id,
        inviteId: conversationJoinRequests.inviteId,
        createdAt: conversationJoinRequests.createdAt,
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        gender: users.gender,
      })
      .from(conversationJoinRequests)
      .innerJoin(users, eq(users.id, conversationJoinRequests.userId))
      .where(
        and(
          eq(conversationJoinRequests.conversationId, conversationId),
          eq(conversationJoinRequests.status, 'pending'),
        ),
      )
      .orderBy(asc(conversationJoinRequests.createdAt));

    return rows.map((row) => ({
      id: row.id,
      inviteId: row.inviteId,
      createdAt: row.createdAt,
      user: {
        id: row.userId,
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        gender: row.gender,
      },
    }));
  }

  async resolveJoinRequest(
    conversationId: string,
    requesterId: string,
    requestId: string,
    action: 'approve' | 'reject',
  ): Promise<JoinResult> {
    await this.requireAdmin(conversationId, requesterId);

    const [request] = await this.db
      .select()
      .from(conversationJoinRequests)
      .where(
        and(
          eq(conversationJoinRequests.id, requestId),
          eq(conversationJoinRequests.conversationId, conversationId),
        ),
      )
      .limit(1);
    if (!request) {
      throw new NotFoundException('Demande introuvable');
    }
    if (request.status !== 'pending') {
      throw new ConflictException('Cette demande a déjà été traitée');
    }

    if (action === 'approve') {
      const [invite] = await this.db
        .select()
        .from(conversationInvites)
        .where(eq(conversationInvites.id, request.inviteId))
        .limit(1);
      if (
        invite &&
        invite.maxUses !== null &&
        invite.uses >= invite.maxUses
      ) {
        throw new ConflictException('Invitation épuisée');
      }
      await this.addMemberWithinLimit(conversationId, request.userId);
      if (invite) {
        await this.db
          .update(conversationInvites)
          .set({ uses: sql`${conversationInvites.uses} + 1` })
          .where(eq(conversationInvites.id, invite.id));
      }
    }

    await this.db
      .update(conversationJoinRequests)
      .set({
        status: action === 'approve' ? 'approved' : 'rejected',
        resolvedAt: new Date(),
        resolvedById: requesterId,
      })
      .where(eq(conversationJoinRequests.id, requestId));

    if (action === 'approve') {
      this.events.publish({
        kind: 'members',
        conversationId,
        actorId: requesterId,
        action: 'added',
        userIds: [request.userId],
      });
      await this.announceJoin(conversationId, request.userId);
    }
    return {
      status: action === 'approve' ? 'joined' : 'rejected',
      conversationId,
    };
  }

  /* --------------------------------- interne -------------------------------- */

  /** Message système « X a rejoint le groupe » (jamais bloquant). */
  private async announceJoin(conversationId: string, userId: string): Promise<void> {
    try {
      const state = await this.conversations.groupState(conversationId);
      const member = state.members.find((entry) => entry.id === userId);
      if (member) {
        await this.conversations.postSystemMessage(
          conversationId,
          userId,
          `${member.displayName} a rejoint le groupe`,
        );
      }
    } catch {
      // Information seulement : l'échec du message ne remet pas en cause l'adhésion.
    }
  }

  private async loadInvite(token: string) {
    const [row] = await this.db
      .select({
        invite: conversationInvites,
        conversation: conversations,
      })
      .from(conversationInvites)
      .innerJoin(conversations, eq(conversations.id, conversationInvites.conversationId))
      .where(eq(conversationInvites.token, token))
      .limit(1);
    if (!row) {
      throw new NotFoundException('Invitation introuvable');
    }
    const memberCount = await this.memberCount(row.conversation.id);
    return { ...row, memberCount, status: this.statusOf(row.invite, memberCount) };
  }

  private statusOf(invite: typeof conversationInvites.$inferSelect, memberCount: number): InviteStatus {
    if (invite.revokedAt) {
      return 'revoked';
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      return 'expired';
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      return 'exhausted';
    }
    if (memberCount >= MAX_GROUP_MEMBERS) {
      return 'full';
    }
    return 'ok';
  }

  private throwForStatus(status: InviteStatus): never {
    if (status === 'expired' || status === 'revoked') {
      throw new GoneException(
        status === 'expired' ? 'Invitation expirée' : 'Invitation révoquée',
      );
    }
    throw new ConflictException(
      status === 'full' ? 'Groupe complet' : 'Invitation épuisée',
    );
  }

  private async memberCount(conversationId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    return Number(row?.count ?? 0);
  }

  private async requireGroupMembership(conversationId: string, userId: string): Promise<void> {
    const [conversation] = await this.db
      .select({ type: conversations.type })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.type !== 'GROUP') {
      throw new ForbiddenException('Les invitations sont réservées aux groupes');
    }
    if (!(await this.conversations.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
  }

  private async requireAdmin(conversationId: string, userId: string): Promise<void> {
    if ((await this.conversations.roleOf(conversationId, userId)) !== 'admin') {
      throw new ForbiddenException('Seuls les administrateurs peuvent gérer les demandes');
    }
  }

  /** Ajout sous verrou de ligne : le plafond ne peut pas être dépassé en course. */
  private async addMemberWithinLimit(conversationId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from conversations where id = ${conversationId} for update`);
      const [existing] = await tx
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        )
        .limit(1);
      if (existing) {
        return;
      }
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      if (Number(row?.count ?? 0) >= MAX_GROUP_MEMBERS) {
        throw new ConflictException(`Groupe complet (${MAX_GROUP_MEMBERS} membres maximum)`);
      }
      await tx.insert(conversationMembers).values({ conversationId, userId });
    });
  }

  private toDto(
    invite: typeof conversationInvites.$inferSelect,
    memberCount: number,
  ): InviteDto {
    return {
      id: invite.id,
      token: invite.token,
      conversationId: invite.conversationId,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      uses: invite.uses,
      requiresApproval: invite.requiresApproval,
      createdAt: invite.createdAt,
      status: this.statusOf(invite, memberCount),
    };
  }
}
