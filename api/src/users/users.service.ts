import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, max, ne, notInArray, or } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  blocks,
  conversationMembers,
  messages,
  pushTokens,
  users,
  type User,
} from '../db/schema.js';
import { calculateAge, isMinor, isPlausibleBirthday } from './age.js';
import { GeocodingService } from './geocoding.service.js';
import { evaluateCityUpdate } from './location-policy.js';
import { canSee, type ViewerRelation, type Visibility } from './visibility.js';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  /** Genre déclaré à l'inscription, pour choisir l'avatar par défaut. */
  gender: string | null;
  notificationsEnabled: boolean;
  /** Son des notifications poussées. */
  notificationSound: boolean;
  /** Aperçu du texte dans les notifications. */
  notificationPreview: boolean;
  createdAt: Date;
}

/** Vue d'un autre compte : préférences privées retirées, champs filtrés. */
export interface PublicUserView {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  gender: string | null;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    gender: user.gender,
    notificationsEnabled: user.notificationsEnabled,
    notificationSound: user.notificationSound,
    notificationPreview: user.notificationPreview,
    createdAt: user.createdAt,
  };
}

/**
 * Profil d'un autre compte : photo et bio masquées selon sa visibilité, et
 * jamais ses préférences de notification. L'âge et la ville sont ajoutés par
 * `getProfile` quand la visibilité les autorise.
 */
export function toPublicUserView(user: User, relation: ViewerRelation): PublicUserView {
  const visible = canSee(user.profileVisibility, relation);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: visible ? user.bio : null,
    avatarUrl: visible ? user.avatarUrl : null,
    gender: user.gender,
    createdAt: user.createdAt,
  };
}

/** Profil « façon Instagram » : infos publiques + âge/ville filtrés + stats. */
export interface UserProfile extends PublicUserView {
  isMe: boolean;
  /** Âge révolu calculé à la requête ; jamais la date de naissance. */
  age: number | null;
  city: string | null;
  country: string | null;
  birthdateSet: boolean;
  stats: {
    /** Nombre de messages envoyés par l'utilisateur. */
    messages: number;
    /** Nombre de discussions partagées avec le visiteur (toutes si c'est son profil). */
    conversations: number;
  };
}

export interface UserSettings {
  privacy: {
    profile: Visibility;
    write: Visibility;
    groupAdd: Visibility;
    call: Visibility;
    discoverability: Visibility;
  };
  readReceipts: boolean;
  typingIndicator: boolean;
  notifications: {
    enabled: boolean;
    messages: boolean;
    groups: boolean;
    mentions: boolean;
    calls: boolean;
    reactions: boolean;
    sound: boolean;
    preview: boolean;
  };
  quietHours: {
    enabled: boolean;
    startMinute: number;
    endMinute: number;
    utcOffsetMinutes: number;
  };
  city: string | null;
  country: string | null;
  cityUpdatedAt: Date | null;
  birthdateSet: boolean;
  age: number | null;
}

export type SettingsPatch = {
  privacy?: Partial<UserSettings['privacy']>;
  readReceipts?: boolean;
  typingIndicator?: boolean;
  notifications?: Partial<UserSettings['notifications']>;
  quietHours?: Partial<UserSettings['quietHours']>;
};

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly geocoding: GeocodingService,
  ) {}

  async findById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  async findManyByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.db.select().from(users).where(inArray(users.id, ids));
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

  /**
   * Relations visiteur → cibles : contact si une conversation est partagée,
   * bloqué si l'un des deux a bloqué l'autre. Aucune requête si la liste est vide.
   */
  async relationsFor(
    viewerId: string,
    targetIds: string[],
  ): Promise<Map<string, ViewerRelation>> {
    const unique = [...new Set(targetIds.filter((id) => id !== viewerId))];
    const map = new Map<string, ViewerRelation>();
    for (const id of unique) {
      map.set(id, { isContact: false, blocked: false });
    }
    if (unique.length === 0) {
      return map;
    }

    const blockRows = await this.db
      .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(
        and(
          or(eq(blocks.blockerId, viewerId), eq(blocks.blockedId, viewerId)),
          or(inArray(blocks.blockerId, unique), inArray(blocks.blockedId, unique)),
        ),
      );
    for (const row of blockRows) {
      const other = row.blockerId === viewerId ? row.blockedId : row.blockerId;
      const entry = map.get(other);
      if (entry) {
        entry.blocked = true;
      }
    }

    const mine = await this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, viewerId));
    const conversationIds = mine.map((row) => row.conversationId);
    if (conversationIds.length > 0) {
      const shared = await this.db
        .selectDistinct({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            inArray(conversationMembers.conversationId, conversationIds),
            inArray(conversationMembers.userId, unique),
          ),
        );
      for (const row of shared) {
        const entry = map.get(row.userId);
        if (entry) {
          entry.isContact = true;
        }
      }
    }
    return map;
  }

  async relationWith(viewerId: string, targetId: string): Promise<ViewerRelation> {
    if (viewerId === targetId) {
      return { isContact: true, blocked: false };
    }
    const relations = await this.relationsFor(viewerId, [targetId]);
    return relations.get(targetId) ?? { isContact: false, blocked: false };
  }

  async getSettings(userId: string): Promise<UserSettings> {
    return this.settingsOf(await this.getByIdOrThrow(userId));
  }

  settingsOf(user: User): UserSettings {
    return {
      privacy: {
        profile: user.profileVisibility,
        write: user.writePermission,
        groupAdd: user.groupAddPermission,
        call: user.callPermission,
        discoverability: user.discoverability,
      },
      readReceipts: user.readReceipts,
      typingIndicator: user.typingIndicator,
      notifications: {
        enabled: user.notificationsEnabled,
        messages: user.notifyMessages,
        groups: user.notifyGroups,
        mentions: user.notifyMentions,
        calls: user.notifyCalls,
        reactions: user.notifyReactions,
        sound: user.notificationSound,
        preview: user.notificationPreview,
      },
      quietHours: {
        enabled: user.quietHoursEnabled,
        startMinute: user.quietStartMinute,
        endMinute: user.quietEndMinute,
        utcOffsetMinutes: user.quietUtcOffsetMinutes,
      },
      city: user.city,
      country: user.country,
      cityUpdatedAt: user.cityUpdatedAt,
      birthdateSet: Boolean(user.birthday),
      age: calculateAge(user.birthday),
    };
  }

  private static visibility(value: unknown): Visibility | undefined {
    return value === 'everyone' || value === 'contacts' || value === 'nobody'
      ? value
      : undefined;
  }

  private static minute(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439
      ? value
      : undefined;
  }

  async updateSettings(userId: string, patch: SettingsPatch): Promise<UserSettings> {
    const values: Partial<typeof users.$inferInsert> = {};
    if (patch.privacy) {
      const profile = UsersService.visibility(patch.privacy.profile);
      const write = UsersService.visibility(patch.privacy.write);
      const groupAdd = UsersService.visibility(patch.privacy.groupAdd);
      const call = UsersService.visibility(patch.privacy.call);
      const discoverability = UsersService.visibility(patch.privacy.discoverability);
      if (profile) values.profileVisibility = profile;
      if (write) values.writePermission = write;
      if (groupAdd) values.groupAddPermission = groupAdd;
      if (call) values.callPermission = call;
      if (discoverability) values.discoverability = discoverability;
    }
    if (typeof patch.readReceipts === 'boolean') {
      values.readReceipts = patch.readReceipts;
    }
    if (typeof patch.typingIndicator === 'boolean') {
      values.typingIndicator = patch.typingIndicator;
    }
    if (patch.notifications) {
      const n = patch.notifications;
      if (typeof n.enabled === 'boolean') values.notificationsEnabled = n.enabled;
      if (typeof n.messages === 'boolean') values.notifyMessages = n.messages;
      if (typeof n.groups === 'boolean') values.notifyGroups = n.groups;
      if (typeof n.mentions === 'boolean') values.notifyMentions = n.mentions;
      if (typeof n.calls === 'boolean') values.notifyCalls = n.calls;
      if (typeof n.reactions === 'boolean') values.notifyReactions = n.reactions;
      if (typeof n.sound === 'boolean') values.notificationSound = n.sound;
      if (typeof n.preview === 'boolean') values.notificationPreview = n.preview;
    }
    if (patch.quietHours) {
      const q = patch.quietHours;
      if (typeof q.enabled === 'boolean') values.quietHoursEnabled = q.enabled;
      const start = UsersService.minute(q.startMinute);
      const end = UsersService.minute(q.endMinute);
      if (start !== undefined) values.quietStartMinute = start;
      if (end !== undefined) values.quietEndMinute = end;
      if (
        typeof q.utcOffsetMinutes === 'number' &&
        Number.isInteger(q.utcOffsetMinutes) &&
        Math.abs(q.utcOffsetMinutes) <= 840
      ) {
        values.quietUtcOffsetMinutes = q.utcOffsetMinutes;
      }
    }
    if (Object.keys(values).length > 0) {
      await this.db.update(users).set(values).where(eq(users.id, userId));
    }
    return this.getSettings(userId);
  }

  /**
   * Met à jour la ville depuis une position approximative. Le serveur géocode,
   * applique le délai de 24 h et l'anti-téléport, puis jette les coordonnées.
   */
  async updateLocation(
    userId: string,
    latitude: number,
    longitude: number,
    mocked: boolean,
  ): Promise<{
    updated: boolean;
    city: string | null;
    country: string | null;
    cityUpdatedAt: Date | null;
    reason?: 'same-city' | 'too-soon' | 'teleport' | 'no-city' | 'geocode';
  }> {
    if (mocked) {
      throw new BadRequestException('Position simulée refusée.');
    }
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new BadRequestException('Position invalide.');
    }
    const user = await this.getByIdOrThrow(userId);
    const place = await this.geocoding.reverse(latitude, longitude);
    if (!place) {
      return {
        updated: false,
        city: user.city,
        country: user.country,
        cityUpdatedAt: user.cityUpdatedAt,
        reason: 'geocode',
      };
    }
    const oldCoords = user.city
      ? await this.geocoding.coordsForCity(user.city, user.country)
      : null;
    const decision = evaluateCityUpdate({
      hasCity: Boolean(user.city),
      oldCity: user.city,
      oldCountry: user.country,
      oldUpdatedAt: user.cityUpdatedAt,
      newCity: place.city,
      newCountry: place.country,
      newCoords: { latitude: place.latitude, longitude: place.longitude },
      oldCoords,
      now: new Date(),
    });
    if (!decision.accept) {
      return {
        updated: false,
        city: user.city,
        country: user.country,
        cityUpdatedAt: user.cityUpdatedAt,
        reason: decision.reason,
      };
    }
    const cityUpdatedAt = new Date();
    await this.db
      .update(users)
      .set({ city: place.city, country: place.country, cityUpdatedAt })
      .where(eq(users.id, userId));
    return {
      updated: true,
      city: place.city,
      country: place.country,
      cityUpdatedAt,
    };
  }

  /** Date de naissance : renseignée une seule fois, jamais modifiable. */
  async setBirthdate(userId: string, birthday: string | undefined): Promise<UserSettings> {
    if (!birthday || !isPlausibleBirthday(birthday)) {
      throw new BadRequestException(
        'La date de naissance est invalide ou l’âge minimum n’est pas atteint.',
      );
    }
    const user = await this.getByIdOrThrow(userId);
    if (user.birthday) {
      throw new BadRequestException('La date de naissance ne peut plus être modifiée.');
    }
    await this.db.update(users).set({ birthday }).where(eq(users.id, userId));
    if (isMinor(birthday)) {
      await this.applyMinorDefaults(userId);
    }
    return this.getSettings(userId);
  }

  /** Mineurs : ville masquée, introuvables par les inconnus, ajout aux contacts. */
  async applyMinorDefaults(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        cityVisible: false,
        discoverability: 'contacts',
        groupAddPermission: 'contacts',
      })
      .where(eq(users.id, userId));
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
      notificationSound?: boolean;
      notificationPreview?: boolean;
    },
  ): Promise<User> {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.bio !== undefined) patch.bio = data.bio;
    if (data.avatarUrl !== undefined) patch.avatarUrl = data.avatarUrl;
    if (data.notificationsEnabled !== undefined) {
      patch.notificationsEnabled = data.notificationsEnabled;
    }
    if (data.notificationSound !== undefined) {
      patch.notificationSound = data.notificationSound;
    }
    if (data.notificationPreview !== undefined) {
      patch.notificationPreview = data.notificationPreview;
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
  async listBlocked(blockerId: string): Promise<PublicUserView[]> {
    const rows = await this.db
      .select({ user: users })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .where(eq(blocks.blockerId, blockerId));
    const relations = await this.relationsFor(
      blockerId,
      rows.map((row) => row.user.id),
    );
    return rows.map((row) =>
      toPublicUserView(row.user, relations.get(row.user.id) ?? { isContact: false, blocked: true }),
    );
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

  /**
   * Enregistre (ou met à jour) le jeton push d'un appareil, pour ce compte
   * uniquement. La mise à jour ne touche jamais `userId` : soumettre le jeton de
   * quelqu'un d'autre ne peut pas vous l'attribuer.
   */
  async registerPushToken(
    userId: string,
    token: string,
    platform: string,
    baseUrl?: string,
  ): Promise<void> {
    const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl);
    await this.db
      .insert(pushTokens)
      .values({ userId, token, platform, baseUrl: normalizedBaseUrl })
      .onConflictDoUpdate({
        target: [pushTokens.userId, pushTokens.token],
        set: { platform, baseUrl: normalizedBaseUrl },
      });
  }

  /** Retire le jeton de CE compte uniquement. */
  async removePushToken(userId: string, token: string): Promise<void> {
    await this.db
      .delete(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
  }

  /** Seule une adresse HTTP(s) de l'API a du sens dans une notification. */
  private normalizeBaseUrl(baseUrl: string | undefined): string | null {
    const trimmed = baseUrl?.trim().replace(/\/+$/, '') ?? '';
    if (!trimmed) {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
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
    const relation = isMe
      ? { isContact: true, blocked: false }
      : await this.relationWith(viewerId, user.id);
    const view = isMe ? toPublicUser(user) : toPublicUserView(user, relation);
    const canSeeProfile = isMe || canSee(user.profileVisibility, relation);

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
      id: view.id,
      username: view.username,
      displayName: view.displayName,
      bio: view.bio,
      avatarUrl: view.avatarUrl,
      gender: view.gender,
      createdAt: view.createdAt,
      isMe,
      age: canSeeProfile ? calculateAge(user.birthday) : null,
      city: isMe || (canSeeProfile && user.cityVisible) ? user.city : null,
      country: isMe || (canSeeProfile && user.cityVisible) ? user.country : null,
      birthdateSet: Boolean(user.birthday),
      stats: {
        messages: messagesRow?.value ?? 0,
        conversations: conversationsCount,
      },
    };
  }

  /**
   * Suggestions de contacts : d'abord les personnes avec qui on discute
   * récemment, puis les autres comptes par ordre alphabétique. Les comptes
   * bloqués (dans un sens ou dans l'autre) n'apparaissent jamais.
   */
  async suggestions(
    userId: string,
    limit = 50,
  ): Promise<{ recent: PublicUserView[]; contacts: PublicUserView[] }> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const blockRows = await this.db
      .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
    const blocked = new Set<string>();
    for (const row of blockRows) {
      blocked.add(row.blockerId === userId ? row.blockedId : row.blockerId);
    }

    const mine = await this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, userId));
    const conversationIds = mine.map((row) => row.conversationId);

    const recents: { user: User; at: number }[] = [];
    if (conversationIds.length > 0) {
      const memberRows = await this.db
        .select({ user: users, conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .where(inArray(conversationMembers.conversationId, conversationIds));
      const lastRows = await this.db
        .select({
          conversationId: messages.conversationId,
          last: max(messages.createdAt),
        })
        .from(messages)
        .where(inArray(messages.conversationId, conversationIds))
        .groupBy(messages.conversationId);
      const lastMap = new Map(
        lastRows.map((row) => [
          row.conversationId,
          row.last ? new Date(row.last).getTime() : 0,
        ]),
      );
      const seen = new Set<string>();
      for (const row of memberRows) {
        const member = row.user;
        if (member.id === userId || blocked.has(member.id) || seen.has(member.id)) {
          continue;
        }
        seen.add(member.id);
        recents.push({ user: member, at: lastMap.get(row.conversationId) ?? 0 });
      }
      recents.sort((a, b) => b.at - a.at);
    }

    const recentUsers = recents.slice(0, 20);
    const excluded = new Set<string>([
      userId,
      ...blocked,
      ...recentUsers.map((entry) => entry.user.id),
    ]);

    const others = await this.db
      .select()
      .from(users)
      .where(notInArray(users.id, [...excluded]))
      .orderBy(asc(users.displayName))
      .limit(Math.max(capped - recentUsers.length, 0));

    const relations = await this.relationsFor(userId, [
      ...recentUsers.map((entry) => entry.user.id),
      ...others.map((entry) => entry.id),
    ]);

    return {
      recent: recentUsers.map((entry) =>
        toPublicUserView(
          entry.user,
          relations.get(entry.user.id) ?? { isContact: true, blocked: false },
        ),
      ),
      contacts: others
        .filter((candidate) =>
          canSee(
            candidate.discoverability,
            relations.get(candidate.id) ?? { isContact: false, blocked: false },
          ),
        )
        .map((candidate) =>
          toPublicUserView(
            candidate,
            relations.get(candidate.id) ?? { isContact: false, blocked: false },
          ),
        ),
    };
  }

  async search(query: string, excludeUserId: string): Promise<PublicUserView[]> {
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
    const relations = await this.relationsFor(
      excludeUserId,
      rows.map((row) => row.id),
    );
    return rows
      .filter((row) =>
        canSee(
          row.discoverability,
          relations.get(row.id) ?? { isContact: false, blocked: false },
        ),
      )
      .map((row) =>
        toPublicUserView(
          row,
          relations.get(row.id) ?? { isContact: false, blocked: false },
        ),
      );
  }
}
