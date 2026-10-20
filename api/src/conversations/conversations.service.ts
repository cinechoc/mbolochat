import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { conversationMembers, conversations, messages, users } from '../db/schema.js';
import { UsersService } from '../users/users.service.js';

export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface MemberInfo extends SenderInfo {
  /** Dernier accusé de lecture de ce membre dans la conversation. */
  lastReadAt: Date | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  content: string;
  createdAt: Date;
  sender: SenderInfo;
}

export interface ConversationSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  createdAt: Date;
  members: MemberInfo[];
  lastMessage: (Omit<MessageDto, 'conversationId'> & { conversationId: string }) | null;
  unreadCount: number;
  /** Épinglée par l'utilisateur courant (remonte en tête de liste). */
  pinned: boolean;
  /** Muette par l'utilisateur courant (pas de badge de notification). */
  muted: boolean;
}

export interface ListMessagesOptions {
  before?: Date;
  limit?: number;
}

/** Convertit un timestamp (Date ou chaîne SQL) en millisecondes. */
function timestampOf(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usersService: UsersService,
  ) {}

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async create(currentUserId: string, memberIds: string[], type?: 'DIRECT' | 'GROUP', name?: string): Promise<ConversationSummary> {
    const otherMemberIds = [...new Set(memberIds)].filter((id) => id !== currentUserId);
    if (otherMemberIds.length === 0) {
      throw new BadRequestException('At least one other member is required');
    }
    const resolvedType = type ?? (otherMemberIds.length === 1 && !name ? 'DIRECT' : 'GROUP');

    if (resolvedType === 'DIRECT') {
      if (otherMemberIds.length !== 1) {
        throw new BadRequestException('Direct conversations have exactly two members');
      }
      const existing = await this.findDirectConversation(currentUserId, otherMemberIds[0]);
      if (existing) {
        return this.getSummaryForUser(existing.id, currentUserId);
      }
    }

    const found = await this.db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, otherMemberIds));
    if (found.length !== otherMemberIds.length) {
      throw new BadRequestException('One or more member ids are invalid');
    }

    const [conversation] = await this.db
      .insert(conversations)
      .values({ type: resolvedType, name: resolvedType === 'GROUP' ? (name ?? null) : null })
      .returning();

    await this.db.insert(conversationMembers).values(
      [currentUserId, ...otherMemberIds].map((userId) => ({
        conversationId: conversation.id,
        userId,
      })),
    );

    return this.getSummaryForUser(conversation.id, currentUserId);
  }

  async listForUser(userId: string, conversationId?: string): Promise<ConversationSummary[]> {
    const memberships = await this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.userId, userId),
          conversationId ? eq(conversationMembers.conversationId, conversationId) : undefined,
        ),
      );

    const ids = memberships.map((row) => row.conversationId);
    if (ids.length === 0) {
      return [];
    }

    const conversationRows = await this.db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, ids));

    const memberRows = await this.db
      .select({
        conversationId: conversationMembers.conversationId,
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastReadAt: conversationMembers.lastReadAt,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(inArray(conversationMembers.conversationId, ids));

    const lastMessages = await this.lastMessagesFor(ids);

    // unread counts per conversation for this user
    const unreadRows = await this.db
      .select({
        conversationId: messages.conversationId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, messages.conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .where(
        sql`${messages.senderId} <> ${userId} AND (${conversationMembers.lastReadAt} IS NULL OR ${messages.createdAt} > ${conversationMembers.lastReadAt})`,
      )
      .groupBy(messages.conversationId);
    const unreadMap = new Map(unreadRows.map((r) => [r.conversationId, Number(r.cnt)]));

    // Préférences par utilisateur (épinglage / muet) : uniquement pour l'utilisateur courant.
    const preferenceRows = await this.db
      .select({
        conversationId: conversationMembers.conversationId,
        pinnedAt: conversationMembers.pinnedAt,
        mutedAt: conversationMembers.mutedAt,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.userId, userId),
          inArray(conversationMembers.conversationId, ids),
        ),
      );
    const preferenceMap = new Map(
      preferenceRows.map((row) => [row.conversationId, row]),
    );

    const summaries = conversationRows.map((conversation) => {
      const preferences = preferenceMap.get(conversation.id);
      return {
        id: conversation.id,
        type: conversation.type,
        name: conversation.name,
        createdAt: conversation.createdAt,
        members: memberRows
          .filter((member) => member.conversationId === conversation.id)
          .map(({ id, username, displayName, avatarUrl, lastReadAt }) => ({
            id,
            username,
            displayName,
            avatarUrl,
            lastReadAt,
          })),
        lastMessage: lastMessages.get(conversation.id) ?? null,
        unreadCount: unreadMap.get(conversation.id) ?? 0,
        pinned: Boolean(preferences?.pinnedAt),
        muted: Boolean(preferences?.mutedAt),
      };
    });

    return summaries.sort((a, b) => {
      // Les conversations épinglées d'abord, puis les plus récentes en tête.
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return timestampOf(b.lastMessage?.createdAt ?? b.createdAt) - timestampOf(a.lastMessage?.createdAt ?? a.createdAt);
    });
  }

  async setPreferences(
    conversationId: string,
    userId: string,
    preferences: { pinned?: boolean; muted?: boolean },
  ): Promise<ConversationSummary> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }

    const values: Partial<typeof conversationMembers.$inferInsert> = {};
    if (preferences.pinned !== undefined) {
      values.pinnedAt = preferences.pinned ? new Date() : null;
    }
    if (preferences.muted !== undefined) {
      values.mutedAt = preferences.muted ? new Date() : null;
    }
    if (Object.keys(values).length > 0) {
      await this.db
        .update(conversationMembers)
        .set(values)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        );
    }
    return this.getSummaryForUser(conversationId, userId);
  }

  async rename(conversationId: string, userId: string, name: string): Promise<ConversationSummary> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    await this.db.update(conversations).set({ name: name.trim() || null }).where(eq(conversations.id, conversationId));
    return this.getSummaryForUser(conversationId, userId);
  }

  async addMembers(conversationId: string, userId: string, memberIds: string[]): Promise<ConversationSummary> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const ids = [...new Set(memberIds)].filter((id) => id !== userId);
    if (ids.length === 0) return this.getSummaryForUser(conversationId, userId);
    const found = await this.db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    if (found.length !== ids.length) {
      throw new BadRequestException('One or more member ids are invalid');
    }
    await this.db
      .insert(conversationMembers)
      .values(ids.map((mid) => ({ conversationId, userId: mid })))
      .onConflictDoNothing();
    return this.getSummaryForUser(conversationId, userId);
  }

  async removeMember(conversationId: string, requesterId: string, targetUserId: string): Promise<void> {
    if (!(await this.isMember(conversationId, requesterId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    if (targetUserId !== requesterId) {
      // only allow self-removal or any member? keep simple: allow any member to remove (MVP)
    }
    await this.db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      );
  }

  async getSummaryForUser(conversationId: string, userId: string): Promise<ConversationSummary> {
    const summaries = await this.listForUser(userId, conversationId);
    const summary = summaries[0];
    if (!summary) {
      throw new NotFoundException('Conversation not found');
    }
    return summary;
  }

  async listMessages(
    conversationId: string,
    userId: string,
    options: ListMessagesOptions = {},
  ): Promise<MessageDto[]> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }

    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const rows = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        content: messages.content,
        createdAt: messages.createdAt,
        senderId: users.id,
        senderUsername: users.username,
        senderDisplayName: users.displayName,
        senderAvatarUrl: users.avatarUrl,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          options.before ? lt(messages.createdAt, options.before) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return rows.reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      content: row.content,
      createdAt: row.createdAt,
      sender: {
        id: row.senderId,
        username: row.senderUsername,
        displayName: row.senderDisplayName,
        avatarUrl: row.senderAvatarUrl,
      },
    }));
  }

  async markRead(conversationId: string, userId: string): Promise<void> {
    if (!(await this.isMember(conversationId, userId))) return;
    await this.db
      .update(conversationMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      );
  }

  /** Marque comme lues toutes les conversations de l'utilisateur. */
  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(conversationMembers)
      .set({ lastReadAt: new Date() })
      .where(eq(conversationMembers.userId, userId));
  }

  async createMessage(conversationId: string, senderId: string, content: string): Promise<MessageDto> {
    if (!(await this.isMember(conversationId, senderId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }

    const [message] = await this.db
      .insert(messages)
      .values({ conversationId, senderId, content })
      .returning();

    const sender = await this.usersService.getByIdOrThrow(senderId);
    return {
      id: message.id,
      conversationId: message.conversationId,
      content: message.content,
      createdAt: message.createdAt,
      sender: {
        id: sender.id,
        username: sender.username,
        displayName: sender.displayName,
        avatarUrl: sender.avatarUrl,
      },
    };
  }

  private async findDirectConversation(userA: string, userB: string) {
    const memberA = alias(conversationMembers, 'member_a');
    const memberB = alias(conversationMembers, 'member_b');
    const [row] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(memberA, and(eq(memberA.conversationId, conversations.id), eq(memberA.userId, userA)))
      .innerJoin(memberB, and(eq(memberB.conversationId, conversations.id), eq(memberB.userId, userB)))
      .where(eq(conversations.type, 'DIRECT'))
      .limit(1);
    return row;
  }

  private async lastMessagesFor(conversationIds: string[]): Promise<Map<string, MessageDto>> {
    const inList = sql.join(
      conversationIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await this.db.execute<{
      id: string;
      conversationId: string;
      content: string;
      createdAt: Date;
      senderId: string;
      senderUsername: string;
      senderDisplayName: string;
      senderAvatarUrl: string | null;
    }>(sql`
      select distinct on (m.conversation_id)
        m.id,
        m.conversation_id as "conversationId",
        m.content,
        m.created_at as "createdAt",
        u.id as "senderId",
        u.username as "senderUsername",
        u.display_name as "senderDisplayName",
        u.avatar_url as "senderAvatarUrl"
      from messages m
      inner join users u on u.id = m.sender_id
      where m.conversation_id in (${inList})
      order by m.conversation_id, m.created_at desc
    `);

    const map = new Map<string, MessageDto>();
    for (const row of result.rows) {
      map.set(row.conversationId, {
        id: row.id,
        conversationId: row.conversationId,
        content: row.content,
        // Les requêtes brutes renvoient les timestamps en chaîne : on normalise en Date.
        createdAt: new Date(row.createdAt),
        sender: {
          id: row.senderId,
          username: row.senderUsername,
          displayName: row.senderDisplayName,
          avatarUrl: row.senderAvatarUrl ?? null,
        },
      });
    }
    return map;
  }
}
