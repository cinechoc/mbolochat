import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ilike, ne, or } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { users, type User } from '../db/schema.js';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
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
