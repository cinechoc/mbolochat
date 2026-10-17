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
  members: SenderInfo[];
  lastMessage: (Omit<MessageDto, 'conversationId'> & { conversationId: string }) | null;
}

export interface ListMessagesOptions {
  before?: Date;
  limit?: number;
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
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(inArray(conversationMembers.conversationId, ids));

    const lastMessages = await this.lastMessagesFor(ids);

    const summaries = conversationRows.map((conversation) => ({
      id: conversation.id,
      type: conversation.type,
      name: conversation.name,
      createdAt: conversation.createdAt,
      members: memberRows
        .filter((member) => member.conversationId === conversation.id)
        .map(({ id, username, displayName }) => ({ id, username, displayName })),
      lastMessage: lastMessages.get(conversation.id) ?? null,
    }));

    return summaries.sort((a, b) => {
      const aDate = (a.lastMessage?.createdAt ?? a.createdAt).getTime();
      const bDate = (b.lastMessage?.createdAt ?? b.createdAt).getTime();
      return bDate - aDate;
    });
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
      },
    }));
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
      sender: { id: sender.id, username: sender.username, displayName: sender.displayName },
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
    }>(sql`
      select distinct on (m.conversation_id)
        m.id,
        m.conversation_id as "conversationId",
        m.content,
        m.created_at as "createdAt",
        u.id as "senderId",
        u.username as "senderUsername",
        u.display_name as "senderDisplayName"
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
        createdAt: row.createdAt,
        sender: {
          id: row.senderId,
          username: row.senderUsername,
          displayName: row.senderDisplayName,
        },
      });
    }
    return map;
  }
}
