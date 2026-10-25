import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  conversationMembers,
  conversations,
  messageHides,
  messageReceipts,
  messages,
  users,
  type MessageAttachment,
} from '../db/schema.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { UsersService } from '../users/users.service.js';
import type { StickerAttachmentMeta } from '../chat/sticker-attachment.js';
import { isValidStickerRef, isMessageType, type MessageType } from '../chat/sticker-ref.js';

export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface MemberInfo extends SenderInfo {
  /** Dernier accusé de lecture de ce membre dans la conversation. */
  lastReadAt: Date | null;
  /** Admin : il peut renommer, inviter et exclure. */
  role: 'admin' | 'member';
}

/** Aperçu du message cité par une réponse — assez pour l'afficher, pas pour la relire. */
export interface MessageQuoteDto {
  id: string;
  senderName: string;
  content: string;
  type: MessageType;
  attachmentType: MessageAttachment['type'] | null;
  /** Le message cité a été retiré depuis : on l'affiche comme tel. */
  deleted: boolean;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  type: MessageType;
  content: string;
  /** Référence de catalogue d'un sticker, null pour les autres messages. */
  stickerRef: string | null;
  /** Pièce jointe (photo…), null pour un message texte. */
  attachment: MessageAttachment | null;
  /** Clé d'idempotence de l'appareil émetteur (null pour l'historique ancien). */
  clientId: string | null;
  /** Message retiré pour tous : contenu et pièce jointe ne sont plus en base. */
  deleted: boolean;
  /** Citation d'une réponse, null pour un message simple. */
  replyTo: MessageQuoteDto | null;
  createdAt: Date;
  sender: SenderInfo;
}

/** Accusé de réception d'un message pour un membre : reçu / lu. */
export interface ReceiptDto {
  messageId: string;
  userId: string;
  deliveredAt: Date | null;
  readAt: Date | null;
}

/** Accusé nouvellement apparu, avec de quoi prévenir l'expéditeur. */
export interface ReceiptChange extends ReceiptDto {
  conversationId: string;
  senderId: string;
}

/** Ligne renvoyée par les requêtes d'accusés (timestamps en chaîne). */
type ReceiptRow = {
  messageId: string;
  userId: string;
  deliveredAt: Date | string | null;
  readAt: Date | string | null;
  conversationId: string;
  senderId: string;
};

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function toReceiptChange(row: ReceiptRow): ReceiptChange {
  return {
    messageId: row.messageId,
    userId: row.userId,
    conversationId: row.conversationId,
    senderId: row.senderId,
    deliveredAt: toDate(row.deliveredAt),
    readAt: toDate(row.readAt),
  };
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
  /** Masquée par l'utilisateur courant (absente de la liste principale). */
  hidden: boolean;
  /** Rôle de l'utilisateur courant dans cette conversation. */
  myRole: 'admin' | 'member';
}

export interface ListMessagesOptions {
  before?: Date;
  /** Curseur de rattrapage : messages postérieurs, dans l'ordre chronologique. */
  after?: Date;
  limit?: number;
}

/** Convertit un timestamp (Date ou chaîne SQL) en millisecondes. */
function timestampOf(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Le message cité et son auteur, joints à chaque lecture d'historique. */
const quoted = alias(messages, 'quoted_message');
const quotedSender = alias(users, 'quoted_sender');

/** Une citation tient sur une ligne : l'aperçu est coupé, pas stocké. */
const QUOTE_PREVIEW_CHARS = 140;

/** Passé ce délai, un message ne se retire plus que pour soi. */
const UNSEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Colonnes communes aux sélections de messages (historique, rattrapage, liste). */
const messageColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  type: messages.type,
  stickerRef: messages.stickerRef,
  content: messages.content,
  attachment: messages.attachment,
  clientId: messages.clientId,
  deletedAt: messages.deletedAt,
  replyToId: messages.replyToId,
  createdAt: messages.createdAt,
  senderId: users.id,
  senderUsername: users.username,
  senderDisplayName: users.displayName,
  senderAvatarUrl: users.avatarUrl,
  quotedContent: quoted.content,
  quotedType: quoted.type,
  quotedStickerRef: quoted.stickerRef,
  quotedAttachment: quoted.attachment,
  quotedDeletedAt: quoted.deletedAt,
  quotedSenderName: quotedSender.displayName,
};

/** Ligne plate produite par la jointure messages × users × message cité. */
interface MessageRow {
  id: string;
  conversationId: string;
  type: string;
  stickerRef: string | null;
  content: string;
  attachment: MessageAttachment | null;
  clientId: string | null;
  deletedAt: Date | null;
  replyToId: string | null;
  createdAt: Date;
  senderId: string;
  senderUsername: string;
  senderDisplayName: string;
  senderAvatarUrl: string | null;
  quotedContent: string | null;
  quotedType: string | null;
  quotedStickerRef: string | null;
  quotedAttachment: MessageAttachment | null;
  quotedDeletedAt: Date | null;
  quotedSenderName: string | null;
}

/** Citation d'un message, à partir de la ligne plate. `null` sans message cité. */
function toQuoteDto(row: MessageRow): MessageQuoteDto | null {
  if (!row.replyToId) {
    return null;
  }
  // Le message cité a pu être retiré pour tous depuis : la citation l'annonce.
  const gone = row.quotedDeletedAt !== null || !row.quotedSenderName;
  const preview = gone ? '' : (row.quotedContent ?? '').slice(0, QUOTE_PREVIEW_CHARS);
  return {
    id: row.replyToId,
    senderName: row.quotedSenderName ?? 'Message',
    content: preview,
    type: gone ? 'text' : row.quotedType === 'sticker' ? 'sticker' : 'text',
    attachmentType: gone ? null : (row.quotedAttachment?.type ?? null),
    deleted: gone,
  };
}

function toMessageDto(row: MessageRow): MessageDto {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: row.type === 'sticker' ? 'sticker' : 'text',
    // « Supprimé pour tous » vide la ligne : rien à renvoyer, juste le témoin.
    content: deleted ? '' : row.content,
    stickerRef: deleted || row.type !== 'sticker' ? null : (row.stickerRef ?? null),
    attachment: deleted ? null : (row.attachment ?? null),
    clientId: row.clientId ?? null,
    deleted,
    replyTo: toQuoteDto(row),
    createdAt: row.createdAt,
    sender: {
      id: row.senderId,
      username: row.senderUsername,
      displayName: row.senderDisplayName,
      avatarUrl: row.senderAvatarUrl ?? null,
    },
  };
}

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usersService: UsersService,
    private readonly uploadsService: UploadsService,
  ) {}

  async listMemberIds(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    return rows.map((row) => row.userId);
  }

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
        // Qui crée le groupe en a la charge ; les invités n'ont pas ce pouvoir.
        role: userId === currentUserId ? ('admin' as const) : ('member' as const),
      })),
    );

    return this.getSummaryForUser(conversation.id, currentUserId);
  }

  async listForUser(
    userId: string,
    conversationId?: string,
    options: { onlyHidden?: boolean } = {},
  ): Promise<ConversationSummary[]> {
    const memberships = await this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.userId, userId),
          conversationId ? eq(conversationMembers.conversationId, conversationId) : undefined,
          // Une conversation ouverte explicitement reste accessible même masquée.
          conversationId ? undefined : eq(conversationMembers.hidden, options.onlyHidden ?? false),
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
        role: conversationMembers.role,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(inArray(conversationMembers.conversationId, ids));

    const lastMessages = await this.lastMessagesFor(ids, userId);

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
        and(
          sql`${messages.senderId} <> ${userId} AND (${conversationMembers.lastReadAt} IS NULL OR ${messages.createdAt} > ${conversationMembers.lastReadAt})`,
          // Un message que j'ai supprimé pour moi ne doit plus compter.
          this.hiddenFrom(userId),
        ),
      )
      .groupBy(messages.conversationId);
    const unreadMap = new Map(unreadRows.map((r) => [r.conversationId, Number(r.cnt)]));

    // Préférences par utilisateur (épinglage / muet) : uniquement pour l'utilisateur courant.
    const preferenceRows = await this.db
      .select({
        conversationId: conversationMembers.conversationId,
        pinnedAt: conversationMembers.pinnedAt,
        mutedAt: conversationMembers.mutedAt,
        hidden: conversationMembers.hidden,
        role: conversationMembers.role,
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
          .map(({ id, username, displayName, avatarUrl, lastReadAt, role }) => ({
            id,
            username,
            displayName,
            avatarUrl,
            lastReadAt,
            role,
          })),
        lastMessage: lastMessages.get(conversation.id) ?? null,
        unreadCount: unreadMap.get(conversation.id) ?? 0,
        pinned: Boolean(preferences?.pinnedAt),
        muted: Boolean(preferences?.mutedAt),
        hidden: Boolean(preferences?.hidden),
        myRole: preferences?.role ?? 'member',
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
    preferences: { pinned?: boolean; muted?: boolean; hidden?: boolean },
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
    if (preferences.hidden !== undefined) {
      values.hidden = preferences.hidden;
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

  /** Conversations masquées par l'utilisateur. */
  async listHiddenForUser(userId: string): Promise<ConversationSummary[]> {
    return this.listForUser(userId, undefined, { onlyHidden: true });
  }

  /** Rôle de ce membre dans cette conversation, ou null s'il n'en est pas. */
  async roleOf(conversationId: string, userId: string): Promise<'admin' | 'member' | null> {
    const [row] = await this.db
      .select({ role: conversationMembers.role })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .limit(1);
    return row?.role ?? null;
  }

  /**
   * Uniquement les administrateurs renomment, invitent ou excluent. Sans cette
   * garde, le moindre membre pouvait rebaptiser la discussion de tout le monde ou
   * en vider les autres.
   */
  private async requireAdmin(conversationId: string, userId: string): Promise<void> {
    if ((await this.roleOf(conversationId, userId)) !== 'admin') {
      throw new ForbiddenException('Seuls les administrateurs peuvent modifier le groupe');
    }
  }

  async rename(conversationId: string, userId: string, name: string): Promise<ConversationSummary> {
    const [conversation] = await this.db
      .select({ type: conversations.type })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    // Une discussion à deux n'a pas de titre à soi : elle porte le nom de
    // l'autre personne, et personne ne peut l'imposer à l'autre.
    if (conversation.type === 'DIRECT') {
      throw new BadRequestException('Une discussion directe ne se renomme pas');
    }
    await this.requireAdmin(conversationId, userId);
    await this.db.update(conversations).set({ name: name.trim() || null }).where(eq(conversations.id, conversationId));
    return this.getSummaryForUser(conversationId, userId);
  }

  async addMembers(conversationId: string, userId: string, memberIds: string[]): Promise<ConversationSummary> {
    await this.requireAdmin(conversationId, userId);
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
    const role = await this.roleOf(conversationId, requesterId);
    if (!role) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    // Un membre peut partir ; seul un administrateur peut mettre dehors.
    if (targetUserId !== requesterId && role !== 'admin') {
      throw new ForbiddenException('Seuls les administrateurs peuvent exclure un membre');
    }
    await this.db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      );

    // Un groupe sans administrateur ne serait plus administrable du tout : on en
    // désigne un, à défaut le plus ancien membre restant.
    const remaining = await this.db
      .select({ userId: conversationMembers.userId, role: conversationMembers.role })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    if (remaining.length > 0 && !remaining.some((member) => member.role === 'admin')) {
      const [heir] = await this.db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId))
        .orderBy(asc(conversationMembers.joinedAt))
        .limit(1);
      if (heir) {
        await this.db
          .update(conversationMembers)
          .set({ role: 'admin' })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, heir.userId),
            ),
          );
      }
    }
  }

  async getSummaryForUser(conversationId: string, userId: string): Promise<ConversationSummary> {
    const summaries = await this.listForUser(userId, conversationId);
    const summary = summaries[0];
    if (!summary) {
      throw new NotFoundException('Conversation not found');
    }
    return summary;
  }

  /**
   * messages × auteur × message cité. La même jointure sert à l'historique, au
   * rattrapage et à la relecture d'un envoi.
   */
  private fromMessages() {
    return this.db
      .select(messageColumns)
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .leftJoin(quoted, eq(quoted.id, messages.replyToId))
      .leftJoin(quotedSender, eq(quotedSender.id, quoted.senderId));
  }

  /** Ce que ce compte a supprimé pour lui ne doit plus jamais lui revenir. */
  private hiddenFrom(userId: string) {
    return notExists(
      this.db
        .select({ one: sql`1` })
        .from(messageHides)
        .where(and(eq(messageHides.userId, userId), eq(messageHides.messageId, messages.id))),
    );
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
    // L'historique se lit du plus récent vers le plus ancien ; le rattrapage
    // (curseur « after ») se lit dans l'ordre chronologique.
    const backwards = options.after === undefined;
    const rows = await this.fromMessages()
      .where(
        and(
          eq(messages.conversationId, conversationId),
          this.hiddenFrom(userId),
          options.before ? lt(messages.createdAt, options.before) : undefined,
          options.after ? gt(messages.createdAt, options.after) : undefined,
        ),
      )
      .orderBy(backwards ? desc(messages.createdAt) : asc(messages.createdAt))
      .limit(limit);

    return (backwards ? rows.reverse() : rows).map(toMessageDto);
  }

  /**
   * Messages reçus depuis un curseur, toutes conversations confondues :
   * c'est ce qui rattrape ce qui est arrivé pendant une coupure réseau.
   *
   * Les timestamps circulent en millisecondes alors que la base les garde en
   * microsecondes : le message servant de curseur peut donc revenir. Le client
   * déduplique par identifiant — c'est le contrat, pas un accident.
   */
  async syncSince(userId: string, since: Date, limit = 300): Promise<MessageDto[]> {
    const rows = await this.fromMessages()
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, messages.conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .where(and(gt(messages.createdAt, since), this.hiddenFrom(userId)))
      .orderBy(asc(messages.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(toMessageDto);
  }

  /**
   * Accusés de réception des messages envoyés par `requesterId` dans cette
   * conversation. Comme WhatsApp, seul l'expéditeur voit qui a reçu et lu.
   */
  async listReceipts(conversationId: string, requesterId: string): Promise<ReceiptDto[]> {
    if (!(await this.isMember(conversationId, requesterId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const rows = await this.db
      .select({
        messageId: messageReceipts.messageId,
        userId: messageReceipts.userId,
        deliveredAt: messageReceipts.deliveredAt,
        readAt: messageReceipts.readAt,
      })
      .from(messageReceipts)
      .innerJoin(messages, eq(messages.id, messageReceipts.messageId))
      .where(and(eq(messages.conversationId, conversationId), eq(messages.senderId, requesterId)));
    return rows.map((row) => ({
      messageId: row.messageId,
      userId: row.userId,
      deliveredAt: row.deliveredAt,
      readAt: row.readAt,
    }));
  }

  async markRead(conversationId: string, userId: string): Promise<ReceiptChange[]> {
    if (!(await this.isMember(conversationId, userId))) return [];
    await this.db
      .update(conversationMembers)
      .set({ lastReadAt: sql`now()` })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      );
    // Tous les messages des autres déjà arrivés sont maintenant « lus », un par
    // un : c'est ce qui autorise la double coche bleue, et seulement elle.
    return this.recordRead(conversationId, userId);
  }

  /** Marque comme lues toutes les conversations de l'utilisateur. */
  async markAllRead(userId: string): Promise<ReceiptChange[]> {
    await this.db
      .update(conversationMembers)
      .set({ lastReadAt: sql`now()` })
      .where(eq(conversationMembers.userId, userId));
    return this.recordRead(null, userId);
  }

  /**
   * Signale que l'appareil de `userId` a bien reçu ces messages : c'est la coche
   * « reçue ». Seuls les messages d'une conversation où l'utilisateur est membre
   * et envoyés par quelqu'un d'autre sont acceptés.
   */
  async markDelivered(userId: string, messageIds: string[]): Promise<ReceiptChange[]> {
    const ids = [...new Set(messageIds)].filter((id) => typeof id === 'string' && id.length > 0).slice(0, 200);
    if (ids.length === 0) return [];

    // Un accusé ne peut concerner qu'un message réellement reçu par cet
    // appareil : dans une de ses conversations, et envoyé par quelqu'un d'autre.
    const candidates = await this.db
      .select({
        messageId: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
      })
      .from(messages)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, messages.conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .where(and(inArray(messages.id, ids), ne(messages.senderId, userId)));
    if (candidates.length === 0) return [];

    const origin = new Map(candidates.map((row) => [row.messageId, row]));
    // La condition `delivered_at is null` limite le RETURNING aux accusés vraiment
    // nouveaux : l'expéditeur n'est prévenu qu'une seule fois.
    const stamped = await this.db
      .insert(messageReceipts)
      .values(
        candidates.map((row) => ({ messageId: row.messageId, userId, deliveredAt: new Date() })),
      )
      .onConflictDoUpdate({
        target: [messageReceipts.messageId, messageReceipts.userId],
        set: { deliveredAt: sql`now()` },
        where: isNull(messageReceipts.deliveredAt),
      })
      .returning({
        messageId: messageReceipts.messageId,
        userId: messageReceipts.userId,
        deliveredAt: messageReceipts.deliveredAt,
        readAt: messageReceipts.readAt,
      });

    return stamped.flatMap((row) => {
      const from = origin.get(row.messageId);
      if (!from) return [];
      return [
        {
          messageId: row.messageId,
          userId: row.userId,
          deliveredAt: row.deliveredAt,
          readAt: row.readAt,
          conversationId: from.conversationId,
          senderId: from.senderId,
        },
      ];
    });
  }

  /**
   * Enregistre la lecture, conversation par conversation (null = toutes), et
   * renvoie les accusés nouvellement créés pour prévenir les expéditeurs.
   */
  private async recordRead(conversationId: string | null, userId: string): Promise<ReceiptChange[]> {
    const scope = conversationId ? sql`and m.conversation_id = ${conversationId}` : sql``;
    const result = await this.db.execute<ReceiptRow>(sql`
      with marked as (
        insert into message_receipts as r (message_id, user_id, delivered_at, read_at)
        select m.id, ${userId}, now(), now()
        from messages m
        join conversation_members cm
          on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}
        where m.sender_id <> ${userId} and m.created_at <= now() ${scope}
        on conflict (message_id, user_id) do update
          set delivered_at = coalesce(r.delivered_at, excluded.delivered_at),
              read_at = excluded.read_at
        where r.read_at is null
        returning message_id, user_id, delivered_at, read_at
      )
      select k.message_id as "messageId", k.user_id as "userId",
             k.delivered_at as "deliveredAt", k.read_at as "readAt",
             m.conversation_id as "conversationId", m.sender_id as "senderId"
      from marked k
      join messages m on m.id = k.message_id
    `);
    return result.rows.map(toReceiptChange);
  }

  async createMessage(
    conversationId: string,
    senderId: string,
    content: string,
    attachmentId?: string,
    clientId?: string,
    replyToId?: string,
    // Pièce jointe GIF externe déjà normalisée par le gateway (allowlist GIPHY).
    gifAttachment?: MessageAttachment | null,
    // Métadonnées d'un sticker importé comme image ; le type final est STICKER.
    sticker?: StickerAttachmentMeta | null,
    messageType: MessageType = 'text',
    stickerRef?: string,
  ): Promise<MessageDto> {
    if (!isMessageType(messageType)) {
      throw new BadRequestException('Type de message invalide');
    }
    if (messageType === 'sticker') {
      if (!isValidStickerRef(stickerRef)) {
        throw new BadRequestException('Référence de sticker invalide');
      }
      if (attachmentId || gifAttachment || sticker) {
        throw new BadRequestException('Un sticker ne porte pas de pièce jointe');
      }
    } else if (stickerRef !== undefined && stickerRef !== null) {
      throw new BadRequestException('stickerRef n’est valide que pour un sticker');
    }

    if (!(await this.isMember(conversationId, senderId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }

    // Un blocage coupe les échanges dans les deux sens. Une seule requête :
    // sinon chaque membre du groupe coûterait un aller-retour à l'envoi.
    const blocked = await this.db.execute<{ one: number }>(sql`
      select 1 as one
      from conversation_members cm
      join blocks b on (
        (b.blocker_id = cm.user_id and b.blocked_id = ${senderId})
        or (b.blocker_id = ${senderId} and b.blocked_id = cm.user_id)
      )
      where cm.conversation_id = ${conversationId} and cm.user_id <> ${senderId}
      limit 1
    `);
    if (blocked.rows.length > 0) {
      throw new ForbiddenException('Cette conversation est bloquée');
    }

    // La pièce jointe doit avoir été importée par l'expéditeur lui-même.
    // Le GIF GIPHY, lui, n'est pas importé : son URL externe validée est
    // stockée telle quelle (jamais re-hébergée ni altérée, exigence GIPHY).
    let attachment: MessageAttachment | null = null;
    if (attachmentId) {
      const upload = await this.uploadsService.findOwned(attachmentId, senderId);
      if (!upload) {
        throw new BadRequestException('Pièce jointe introuvable');
      }
      if (sticker && !upload.mime.startsWith('image/')) {
        throw new BadRequestException('Un sticker doit être une image');
      }
      attachment = {
        type: sticker ? 'STICKER' : upload.type,
        url: upload.url,
        mime: upload.mime,
        size: upload.size,
        width: upload.width,
        height: upload.height,
        duration: sticker ? undefined : upload.duration,
        name: sticker ? (sticker.name ?? upload.name) : upload.name,
        ...(sticker
          ? {
              stickerId: sticker.id,
              stickerPackId: sticker.packId,
              ...(sticker.name !== undefined ? { stickerName: sticker.name } : {}),
            }
          : {}),
      };
    } else if (gifAttachment) {
      attachment = gifAttachment;
    }

    // Une réponse ne peut citer qu'un message de la même discussion.
    if (replyToId) {
      const cited = await this.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, replyToId), eq(messages.conversationId, conversationId)))
        .limit(1);
      if (cited.length === 0) {
        throw new BadRequestException('Le message cité n’appartient pas à cette discussion');
      }
    }

    const [message] = await this.db
      .insert(messages)
      .values({
        conversationId,
        senderId,
        type: messageType,
        stickerRef: messageType === 'sticker' ? stickerRef : null,
        content,
        attachment,
        clientId: clientId ?? null,
        replyToId: replyToId ?? null,
      })
      .onConflictDoNothing({ target: [messages.senderId, messages.clientId] })
      .returning();

    // Reprise après une coupure : ce client a déjà déposé ce message. On
    // renvoie l'original au lieu d'en insérer un deuxième.
    const stored =
      message ??
      (clientId
        ? await this.db
            .select()
            .from(messages)
            .where(and(eq(messages.senderId, senderId), eq(messages.clientId, clientId)))
            .limit(1)
            .then((rows) => rows[0])
        : undefined);
    if (!stored) {
      throw new BadRequestException('Message already processed');
    }

    const sender = await this.usersService.getByIdOrThrow(senderId);
    return {
      id: stored.id,
      conversationId: stored.conversationId,
      type: stored.type === 'sticker' ? 'sticker' : 'text',
      content: stored.content,
      stickerRef: stored.type === 'sticker' ? (stored.stickerRef ?? null) : null,
      attachment: stored.attachment ?? null,
      clientId: stored.clientId ?? null,
      deleted: stored.deletedAt !== null,
      // Un envoi sur deux ne cite rien : on ne paie la jointure que si c'est le cas.
      replyTo: stored.replyToId ? await this.quoteOf(stored.replyToId) : null,
      createdAt: stored.createdAt,
      sender: {
        id: sender.id,
        username: sender.username,
        displayName: sender.displayName,
        avatarUrl: sender.avatarUrl,
      },
    };
  }

  /** Aperçu d'un message cité, pour l'acquittement d'un envoi avec réponse. */
  private async quoteOf(messageId: string): Promise<MessageQuoteDto | null> {
    const [row] = await this.db
      .select({
        content: messages.content,
        type: messages.type,
        attachment: messages.attachment,
        deletedAt: messages.deletedAt,
        senderName: users.displayName,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!row) {
      return null;
    }
    const gone = row.deletedAt !== null;
    return {
      id: messageId,
      senderName: row.senderName,
      content: gone ? '' : row.content.slice(0, QUOTE_PREVIEW_CHARS),
      type: row.type === 'sticker' ? 'sticker' : 'text',
      attachmentType: gone ? null : (row.attachment?.type ?? null),
      deleted: gone,
    };
  }

  /**
   * « Supprimer pour tous » : l'auteur, et tant que le message est récent. Le
   * contenu et la pièce jointe partent vraiment — un message retiré ne doit pas
   * rester lisible en base. La ligne reste, avec sa date : c'est ce qui permet
   * d'afficher « message supprimé » plutôt qu'une bulle vide, et à une citation
   * d'annoncer que son original a disparu.
   */
  async deleteForEveryone(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<MessageDto> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('Message introuvable');
    }
    if (row.senderId !== userId) {
      throw new ForbiddenException('Seul l’auteur peut retirer un message pour tout le monde');
    }
    if (row.deletedAt) {
      return this.messageDto(messageId);
    }
    if (Date.now() - row.createdAt.getTime() > UNSEND_WINDOW_MS) {
      throw new BadRequestException('Trop tard pour retirer ce message pour tout le monde');
    }

    await this.db
      .update(messages)
      .set({ content: '', stickerRef: null, attachment: null, deletedAt: new Date() })
      .where(eq(messages.id, messageId));
    return this.messageDto(messageId);
  }

  /**
   * « Supprimer pour moi » : la ligne disparaît de la seule vue de ce compte.
   * Les autres membres la lisent toujours — ce n'est pas un retrait collectif.
   */
  async hideForMe(
    conversationId: string,
    messageIds: string[],
    userId: string,
  ): Promise<string[]> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const ids = [...new Set(messageIds)].filter(Boolean).slice(0, 100);
    if (ids.length === 0) {
      return [];
    }
    // On ne peut retirer de sa vue que des messages de cette discussion.
    const owned = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(inArray(messages.id, ids), eq(messages.conversationId, conversationId)));
    const visible = new Set(owned.map((row) => row.id));
    if (visible.size === 0) {
      throw new NotFoundException('Message introuvable');
    }
    await this.db
      .insert(messageHides)
      .values([...visible].map((id) => ({ messageId: id, userId })))
      .onConflictDoNothing();
    return [...visible];
  }

  /** Relit un message unique avec ses jointures habituelles. */
  private async messageDto(messageId: string): Promise<MessageDto> {
    const [row] = await this.fromMessages().where(eq(messages.id, messageId)).limit(1);
    if (!row) {
      throw new NotFoundException('Message introuvable');
    }
    return toMessageDto(row);
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

  /** Dernier message visible par ce compte dans chacune de ses discussions. */
  private async lastMessagesFor(conversationIds: string[], userId: string): Promise<Map<string, MessageDto>> {
    const inList = sql.join(
      conversationIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await this.db.execute<{
      id: string;
      conversationId: string;
      type: string;
      stickerRef: string | null;
      content: string;
      attachment: MessageAttachment | null;
      clientId: string | null;
      deletedAt: Date | string | null;
      createdAt: Date;
      senderId: string;
      senderUsername: string;
      senderDisplayName: string;
      senderAvatarUrl: string | null;
    }>(sql`
      select distinct on (m.conversation_id)
        m.id,
        m.conversation_id as "conversationId",
        m.type,
        m.sticker_ref as "stickerRef",
        m.content,
        m.attachment,
        m.client_id as "clientId",
        m.deleted_at as "deletedAt",
        m.created_at as "createdAt",
        u.id as "senderId",
        u.username as "senderUsername",
        u.display_name as "senderDisplayName",
        u.avatar_url as "senderAvatarUrl"
      from messages m
      inner join users u on u.id = m.sender_id
      where m.conversation_id in (${inList})
        and not exists (
          select 1 from message_hides mh
          where mh.message_id = m.id and mh.user_id = ${userId}
        )
      order by m.conversation_id, m.created_at desc
    `);

    const map = new Map<string, MessageDto>();
    for (const row of result.rows) {
      const deleted = toDate(row.deletedAt) !== null;
      map.set(row.conversationId, {
        id: row.id,
        conversationId: row.conversationId,
        type: row.type === 'sticker' ? 'sticker' : 'text',
        content: deleted ? '' : row.content,
        stickerRef: deleted || row.type !== 'sticker' ? null : (row.stickerRef ?? null),
        attachment: deleted ? null : (row.attachment ?? null),
        clientId: row.clientId ?? null,
        deleted,
        // L'aperçu d'une liste n'affiche pas la citation : jointure inutile ici.
        replyTo: null,
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
