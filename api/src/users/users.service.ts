import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, ilike, inArray, ne, or } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  blocks,
  conversationMembers,
  messages,
  pushTokens,
  users,
  type User,
} from '../db/schema.js';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  notificationsEnabled: boolean;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    notificationsEnabled: user.notificationsEnabled,
    createdAt: user.createdAt,
  };
}

/** Profil « façon Instagram » : infos publiques + quelques statistiques. */
export interface UserProfile extends PublicUser {
  isMe: boolean;
  stats: {
    /** Nombre de messages envoyés par l'utilisateur. */
    messages: number;
    /** Nombre de discussions partagées avec le visiteur (toutes si c'est son profil). */
    conversations: number;
  };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  async getByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findByEmailOrUsername(identifier: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(or(eq(users.email, identifier.toLowerCase()), eq(users.username, identifier)))
      .limit(1);
    return user;
  }

  async create(data: {
    email: string;
    username: string;
    displayName: string;
    passwordHash: string;
    birthday?: string | null;
    gender?: string | null;
  }): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values({
        email: data.email.toLowerCase(),
        username: data.username,
        displayName: data.displayName,
        passwordHash: data.passwordHash,
        birthday: data.birthday ?? null,
        gender: data.gender ?? null,
      })
      .returning();
    return user;
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  async updateProfile(
    userId: string,
    data: {
      displayName?: string;
      bio?: string | null;
      avatarUrl?: string | null;
      notificationsEnabled?: boolean;
    },
  ): Promise<User> {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.bio !== undefined) patch.bio = data.bio;
    if (data.avatarUrl !== undefined) patch.avatarUrl = data.avatarUrl;
    if (data.notificationsEnabled !== undefined) {
      patch.notificationsEnabled = data.notificationsEnabled;
    }
    const [user] = await this.db.update(users).set(patch).where(eq(users.id, userId)).returning();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Bloque un utilisateur (les deux ne peuvent plus s'envoyer de messages). */
  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new NotFoundException('You cannot block yourself');
    }
    await this.getByIdOrThrow(blockedId);
    await this.db
      .insert(blocks)
      .values({ blockerId, blockedId })
      .onConflictDoNothing();
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.db
      .delete(blocks)
      .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)));
  }

  /** Comptes bloqués par l'utilisateur. */
  async listBlocked(blockerId: string): Promise<PublicUser[]> {
    const rows = await this.db
      .select({ user: users })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .where(eq(blocks.blockerId, blockerId));
    return rows.map((row) => toPublicUser(row.user));
  }

  /** L'un des deux a-t-il bloqué l'autre ? */
  async isBlockedBetween(userA: string, userB: string): Promise<boolean> {
    const [row] = await this.db
      .select({ blockerId: blocks.blockerId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, userA), eq(blocks.blockedId, userB)),
          and(eq(blocks.blockerId, userB), eq(blocks.blockedId, userA)),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Enregistre (ou met à jour) le jeton push d'un appareil. */
  async registerPushToken(userId: string, token: string, platform: string): Promise<void> {
    await this.db
      .insert(pushTokens)
      .values({ userId, token, platform })
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: { userId, platform },
      });
  }

  async removePushToken(token: string): Promise<void> {
    await this.db.delete(pushTokens).where(eq(pushTokens.token, token));
  }

  /** Jetons push d'un utilisateur (pour l'envoi de notifications). */
  async listPushTokens(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));
    return rows.map((row) => row.token);
  }

  /** Profil public enrichi (statistiques + indicateurs "c'est moi"). */
  async getProfile(userId: string, viewerId: string): Promise<UserProfile> {
    const user = await this.getByIdOrThrow(userId);
    const isMe = user.id === viewerId;

    const [messagesRow] = await this.db
      .select({ value: count() })
      .from(messages)
      .where(eq(messages.senderId, user.id));

    let conversationsCount: number;
    if (isMe) {
      const [row] = await this.db
        .select({ value: count() })
        .from(conversationMembers)
        .where(eq(conversationMembers.userId, user.id));
      conversationsCount = row?.value ?? 0;
    } else {
      const viewerRows = await this.db
        .select({ conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(eq(conversationMembers.userId, viewerId));
      const sharedIds = viewerRows.map((row) => row.conversationId);
      if (sharedIds.length === 0) {
        conversationsCount = 0;
      } else {
        const [row] = await this.db
          .select({ value: count() })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.userId, user.id),
              inArray(conversationMembers.conversationId, sharedIds),
            ),
          );
        conversationsCount = row?.value ?? 0;
      }
    }

    return {
      ...toPublicUser(user),
      isMe,
      stats: {
        messages: messagesRow?.value ?? 0,
        conversations: conversationsCount,
      },
    };
  }

  async search(query: string, excludeUserId: string): Promise<PublicUser[]> {
    const pattern = `%${query.trim()}%`;
    const rows = await this.db
      .select()
      .from(users)
      .where(
        and(
          ne(users.id, excludeUserId),
          or(ilike(users.username, pattern), ilike(users.displayName, pattern)),
        ),
      )
      .limit(20);
    return rows.map(toPublicUser);
  }
}
