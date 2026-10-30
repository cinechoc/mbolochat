import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  blocks,
  conversationMembers,
  conversations,
  messageHides,
  messageReactions,
  messageReceipts,
  messages,
  users,
  type MessageAttachment,
} from '../db/schema.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { UsersService } from '../users/users.service.js';
import type { StickerAttachmentMeta } from '../chat/sticker-attachment.js';
import { isValidStickerRef, isMessageType, type MessageType } from '../chat/sticker-ref.js';
import {
  isPantherReaction,
  type ReactionSummary,
} from '../chat/reactions.js';
import { ConversationEventsService } from './conversation-events.service.js';
import { MAX_GROUP_MEMBERS } from './group-limits.js';

export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Genre déclaré, pour l'avatar par défaut quand il n'y a pas de photo. */
  gender: string | null;
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
  /** Réactions emoji agrégées, dans l'ordre d'affichage. */
  reactions: ReactionSummary[];
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

/** Média partagé dans une conversation (photo, vidéo, document…). */
export interface ConversationMediaItem {
  messageId: string;
  type: MessageAttachment['type'];
  url: string;
  mime: string;
  name: string | null;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: Date;
  senderName: string;
}

/** Lien repéré dans le texte d'un message. */
export interface ConversationLinkItem {
  messageId: string;
  url: string;
  createdAt: Date;
  senderName: string;
}

/** Résultat de recherche dans l'historique d'une conversation. */
export interface ConversationSearchHit {
  messageId: string;
  content: string;
  createdAt: Date;
  senderName: string;
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
  /** Photo du groupe (chemin de stockage signé à la sortie de l'API). */
  avatarUrl: string | null;
  /** Identité de repli quand le groupe n'a pas de photo. */
  emoji: string | null;
  color: string | null;
  description: string | null;
  /** Créateur du groupe : badge propriétaire. */
  ownerId: string | null;
  /** Qui peut écrire dans le groupe (DIRECT : « all »). */
  whoCanSend: 'all' | 'admins';
  /** Qui peut ajouter des membres (DIRECT : « all »). */
  whoCanAdd: 'all' | 'admins';
  createdAt: Date;
  updatedAt: Date;
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
  /** J'ai bloqué l'autre membre (discussion directe uniquement). */
  blockedByMe: boolean;
  /** L'autre membre m'a bloqué : la saisie est désactivée (direct uniquement). */
  blockedByThem: boolean;
}

/** État complet d'un groupe, à diffuser en temps réel. */
export interface GroupState {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  avatarUrl: string | null;
  emoji: string | null;
  color: string | null;
  description: string | null;
  ownerId: string | null;
  whoCanSend: 'all' | 'admins';
  whoCanAdd: 'all' | 'admins';
  updatedAt: Date;
  memberCount: number;
  members: MemberInfo[];
}

/** Champs d'identité modifiables d'un groupe. */
export interface GroupIdentityInput {
  name?: string;
  description?: string;
  emoji?: string;
  color?: string;
  whoCanSend?: 'all' | 'admins';
  whoCanAdd?: 'all' | 'admins';
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

/** `call` : message système du serveur, jamais envoyé par un client. */
function messageTypeOf(type: string): MessageType {
  if (type === 'sticker') {
    return 'sticker';
  }
  if (type === 'call') {
    return 'call';
  }
  if (type === 'system') {
    return 'system';
  }
  return 'text';
}

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
  senderGender: users.gender,
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
  senderGender: string | null;
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

function toMessageDto(row: MessageRow, reactions: ReactionSummary[] = []): MessageDto {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: messageTypeOf(row.type),
    // « Supprimé pour tous » vide la ligne : rien à renvoyer, juste le témoin.
    content: deleted ? '' : row.content,
    stickerRef: deleted || row.type !== 'sticker' ? null : (row.stickerRef ?? null),
    attachment: deleted ? null : (row.attachment ?? null),
    clientId: row.clientId ?? null,
    deleted,
    replyTo: toQuoteDto(row),
    reactions,
    createdAt: row.createdAt,
    sender: {
      id: row.senderId,
      username: row.senderUsername,
      displayName: row.senderDisplayName,
      avatarUrl: row.senderAvatarUrl ?? null,
      gender: row.senderGender ?? null,
    },
  };
}

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usersService: UsersService,
    private readonly uploadsService: UploadsService,
    private readonly events: ConversationEventsService,
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

  async create(
    currentUserId: string,
    memberIds: string[],
    type?: 'DIRECT' | 'GROUP',
    name?: string,
    identity: {
      emoji?: string;
      color?: string;
      description?: string;
      whoCanSend?: 'all' | 'admins';
      whoCanAdd?: 'all' | 'admins';
    } = {},
  ): Promise<ConversationSummary> {
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

    if (resolvedType === 'GROUP' && otherMemberIds.length + 1 > MAX_GROUP_MEMBERS) {
      throw new BadRequestException(
        `Un groupe est limité à ${MAX_GROUP_MEMBERS} membres`,
      );
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
      .values({
        type: resolvedType,
        name: resolvedType === 'GROUP' ? (name ?? null) : null,
        ownerId: resolvedType === 'GROUP' ? currentUserId : null,
        emoji: resolvedType === 'GROUP' ? (identity.emoji?.trim() || null) : null,
        color: resolvedType === 'GROUP' ? (identity.color?.trim() || null) : null,
        description:
          resolvedType === 'GROUP' ? (identity.description?.trim() || null) : null,
        sendPermission: identity.whoCanSend === 'admins' ? 'admins' : 'all',
        addPermission: identity.whoCanAdd === 'admins' ? 'admins' : 'all',
      })
      .returning();

    await this.db.insert(conversationMembers).values(
      [currentUserId, ...otherMemberIds].map((userId) => ({
        conversationId: conversation.id,
        userId,
        // Qui crée le groupe en a la charge ; les invités n'ont pas ce pouvoir.
        role: userId === currentUserId ? ('admin' as const) : ('member' as const),
      })),
    );

    if (resolvedType === 'GROUP') {
      this.events.publish({
        kind: 'created',
        conversationId: conversation.id,
        userIds: otherMemberIds,
      });
      const creator = await this.usersService.getByIdOrThrow(currentUserId);
      await this.postSystemMessage(
        conversation.id,
        currentUserId,
        `${creator.displayName} a créé le groupe « ${name?.trim() || 'Groupe'} »`,
      );
    }

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
        gender: users.gender,
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
          // Un message système d'appel n'est pas un message non lu.
          sql`${messages.type} not in ('call', 'system')`,
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

    // Blocages impliquant l'utilisateur courant (les deux sens).
    const myBlockRows = await this.db
      .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
    const blockedByMeSet = new Set(
      myBlockRows.filter((row) => row.blockerId === userId).map((row) => row.blockedId),
    );
    const blockedMeSet = new Set(
      myBlockRows.filter((row) => row.blockedId === userId).map((row) => row.blockerId),
    );

    const summaries = conversationRows.map((conversation): ConversationSummary => {
      const preferences = preferenceMap.get(conversation.id);
      const otherId =
        conversation.type === 'DIRECT'
          ? (memberRows.find(
              (member) => member.conversationId === conversation.id && member.id !== userId,
            )?.id ?? null)
          : null;
      return {
        id: conversation.id,
        type: conversation.type,
        name: conversation.name,
        avatarUrl: conversation.avatarUrl ?? null,
        emoji: conversation.emoji ?? null,
        color: conversation.color ?? null,
        description: conversation.description ?? null,
        ownerId: conversation.ownerId ?? null,
        whoCanSend: conversation.sendPermission === 'admins' ? 'admins' : 'all',
        whoCanAdd: conversation.addPermission === 'admins' ? 'admins' : 'all',
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        members: memberRows
          .filter((member) => member.conversationId === conversation.id)
          .map(({ id, username, displayName, avatarUrl, gender, lastReadAt, role }) => ({
            id,
            username,
            displayName,
            avatarUrl,
            gender,
            lastReadAt,
            role,
          })),
        lastMessage: lastMessages.get(conversation.id) ?? null,
        unreadCount: unreadMap.get(conversation.id) ?? 0,
        pinned: Boolean(preferences?.pinnedAt),
        muted: Boolean(preferences?.mutedAt),
        hidden: Boolean(preferences?.hidden),
        myRole: preferences?.role ?? 'member',
        blockedByMe:
          conversation.type === 'DIRECT' && otherId
            ? blockedByMeSet.has(otherId)
            : false,
        blockedByThem:
          conversation.type === 'DIRECT' && otherId ? blockedMeSet.has(otherId) : false,
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
   * Seuls les administrateurs modifient l'identité du groupe, changent les rôles
   * ou excluent. Inviter et ajouter restent ouverts à tous les membres.
   */
  private async requireAdmin(conversationId: string, userId: string): Promise<void> {
    if ((await this.roleOf(conversationId, userId)) !== 'admin') {
      throw new ForbiddenException('Seuls les administrateurs peuvent modifier le groupe');
    }
  }

  /** Charge la conversation et refuse tout ce qui n'est pas un groupe. */
  private async requireGroup(conversationId: string) {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.type === 'DIRECT') {
      throw new BadRequestException('Une discussion directe ne se modifie pas comme un groupe');
    }
    return conversation;
  }

  async updateGroup(
    conversationId: string,
    userId: string,
    input: GroupIdentityInput,
  ): Promise<ConversationSummary> {
    const conversation = await this.requireGroup(conversationId);
    await this.requireAdmin(conversationId, userId);

    const values: Partial<typeof conversations.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      values.name = input.name.trim() || null;
    }
    if (input.description !== undefined) {
      values.description = input.description.trim() || null;
    }
    if (input.emoji !== undefined) {
      values.emoji = input.emoji.trim() || null;
    }
    if (input.color !== undefined) {
      values.color = input.color.trim().toLowerCase() || null;
    }
    if (input.whoCanSend !== undefined) {
      values.sendPermission = input.whoCanSend;
    }
    if (input.whoCanAdd !== undefined) {
      values.addPermission = input.whoCanAdd;
    }
    await this.db
      .update(conversations)
      .set(values)
      .where(eq(conversations.id, conversation.id));

    this.events.publish({ kind: 'updated', conversationId, actorId: userId });
    return this.getSummaryForUser(conversationId, userId);
  }

  /** Photo du groupe : même stockage disque que les avatars utilisateurs. */
  async uploadPhoto(
    conversationId: string,
    userId: string,
    data: string,
    mimeType = 'image/jpeg',
  ): Promise<ConversationSummary> {
    await this.requireGroup(conversationId);
    await this.requireAdmin(conversationId, userId);

    const extensions: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const ext = extensions[mimeType.toLowerCase()];
    if (!ext) {
      throw new BadRequestException('Format d’image non pris en charge');
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('Image vide');
    }
    if (buffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException('Image trop lourde (max 2 Mo)');
    }

    const dir = join(process.cwd(), 'uploads');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const base = `group-${conversationId}`;
    // Une extension différente laisserait l'ancien fichier orphelin et servi.
    for (const other of ['jpg', 'png', 'webp']) {
      if (other !== ext) {
        rmSync(join(dir, `${base}.${other}`), { force: true });
      }
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(join(dir, `${base}.${ext}`));
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      stream.end(buffer);
    });

    const url = `/uploads/${base}.${ext}?v=${Date.now()}`;
    await this.db
      .update(conversations)
      .set({ avatarUrl: url, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    this.events.publish({ kind: 'updated', conversationId, actorId: userId });
    return this.getSummaryForUser(conversationId, userId);
  }

  async deletePhoto(conversationId: string, userId: string): Promise<ConversationSummary> {
    await this.requireGroup(conversationId);
    await this.requireAdmin(conversationId, userId);

    const dir = join(process.cwd(), 'uploads');
    for (const ext of ['jpg', 'png', 'webp']) {
      rmSync(join(dir, `group-${conversationId}.${ext}`), { force: true });
    }
    await this.db
      .update(conversations)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    this.events.publish({ kind: 'updated', conversationId, actorId: userId });
    return this.getSummaryForUser(conversationId, userId);
  }

  /** Promotion ou rétrogradation d'un membre. */
  async updateMemberRole(
    conversationId: string,
    requesterId: string,
    targetUserId: string,
    role: 'admin' | 'member',
  ): Promise<ConversationSummary> {
    const conversation = await this.requireGroup(conversationId);
    await this.requireAdmin(conversationId, requesterId);

    const [target] = await this.db
      .select({ role: conversationMembers.role })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      )
      .limit(1);
    if (!target) {
      throw new NotFoundException('Membre introuvable');
    }

    if (role === 'member' && target.role === 'admin') {
      if (conversation.ownerId === targetUserId) {
        throw new ForbiddenException('Le propriétaire du groupe ne peut pas être rétrogradé');
      }
      const admins = await this.db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.role, 'admin'),
          ),
        );
      if (admins.length <= 1) {
        throw new ConflictException('Il doit rester au moins un administrateur');
      }
    }

    if (target.role !== role) {
      await this.db
        .update(conversationMembers)
        .set({ role })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, targetUserId),
          ),
        );
      await this.db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      this.events.publish({
        kind: 'members',
        conversationId,
        actorId: requesterId,
        action: 'role',
        userIds: [targetUserId],
      });
    }

    return this.getSummaryForUser(conversationId, requesterId);
  }

  /**
   * Ajout de membres : ouvert à tout membre du groupe (comportement Snapchat),
   * dans la limite du plafond. Le verrou de ligne sérialise les ajouts
   * concurrents pour que deux invités ne fassent pas sauter le plafond ensemble.
   */
  async addMembers(conversationId: string, userId: string, memberIds: string[]): Promise<ConversationSummary> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const group = await this.requireGroup(conversationId);
    if (
      group.addPermission === 'admins' &&
      (await this.roleOf(conversationId, userId)) !== 'admin'
    ) {
      throw new ForbiddenException(
        'Seuls les administrateurs peuvent ajouter des membres',
      );
    }

    const ids = [...new Set(memberIds)].filter((id) => id !== userId);
    if (ids.length === 0) {
      return this.getSummaryForUser(conversationId, userId);
    }
    const found = await this.db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    if (found.length !== ids.length) {
      throw new BadRequestException('One or more member ids are invalid');
    }

    const added = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from conversations where id = ${conversationId} for update`);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      const existing = await tx
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            inArray(conversationMembers.userId, ids),
          ),
        );
      const already = new Set(existing.map((row) => row.userId));
      const fresh = ids.filter((id) => !already.has(id));
      if (Number(countRow?.count ?? 0) + fresh.length > MAX_GROUP_MEMBERS) {
        throw new ConflictException(`Groupe complet (${MAX_GROUP_MEMBERS} membres maximum)`);
      }
      if (fresh.length > 0) {
        await tx
          .insert(conversationMembers)
          .values(fresh.map((mid) => ({ conversationId, userId: mid })))
          .onConflictDoNothing();
      }
      return fresh;
    });

    if (added.length > 0) {
      await this.db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      this.events.publish({
        kind: 'members',
        conversationId,
        actorId: userId,
        action: 'added',
        userIds: added,
      });
      const actor = await this.usersService.getByIdOrThrow(userId);
      const addedUsers = await this.db
        .select({ displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, added));
      const names = addedUsers.map((entry) => entry.displayName).join(', ');
      if (names) {
        await this.postSystemMessage(
          conversationId,
          userId,
          `${actor.displayName} a ajouté ${names}`,
        );
      }
    }
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
    if (!(await this.roleOf(conversationId, targetUserId))) {
      throw new NotFoundException('Membre introuvable');
    }

    const [conversation] = await this.db
      .select({ type: conversations.type, ownerId: conversations.ownerId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

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
      .select({
        userId: conversationMembers.userId,
        role: conversationMembers.role,
        joinedAt: conversationMembers.joinedAt,
      })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
      .orderBy(asc(conversationMembers.joinedAt));

    if (conversation?.type === 'GROUP' && remaining.length > 0) {
      let admins = remaining.filter((member) => member.role === 'admin');
      if (admins.length === 0) {
        const heir = remaining[0];
        await this.db
          .update(conversationMembers)
          .set({ role: 'admin' })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, heir.userId),
            ),
          );
        admins = [{ ...heir, role: 'admin' }];
      }
      // Le propriétaire part : la propriété revient au plus ancien admin.
      if (conversation.ownerId === targetUserId) {
        await this.db
          .update(conversations)
          .set({ ownerId: admins[0]?.userId ?? remaining[0].userId, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
      } else {
        await this.db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
      }
    } else if (conversation) {
      await this.db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    }

    if (conversation?.type === 'GROUP') {
      this.events.publish({
        kind: 'members',
        conversationId,
        actorId: requesterId,
        action: targetUserId === requesterId ? 'left' : 'removed',
        userIds: [targetUserId],
      });
      if (remaining.length > 0) {
        const targetUser = await this.usersService.getByIdOrThrow(targetUserId);
        const content =
          targetUserId === requesterId
            ? `${targetUser.displayName} a quitté le groupe`
            : `${targetUser.displayName} a été retiré par ${
                (await this.usersService.getByIdOrThrow(requesterId)).displayName
              }`;
        await this.postSystemMessage(conversationId, requesterId, content);
      }
    }
  }

  /** État complet d'un groupe (identité + membres), pour le temps réel. */
  async groupState(conversationId: string): Promise<GroupState> {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    const members = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        gender: users.gender,
        lastReadAt: conversationMembers.lastReadAt,
        role: conversationMembers.role,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(eq(conversationMembers.conversationId, conversationId))
      .orderBy(asc(conversationMembers.joinedAt));

    return {
      id: conversation.id,
      type: conversation.type,
      name: conversation.name,
      avatarUrl: conversation.avatarUrl ?? null,
      emoji: conversation.emoji ?? null,
      color: conversation.color ?? null,
      description: conversation.description ?? null,
      ownerId: conversation.ownerId ?? null,
      whoCanSend: conversation.sendPermission === 'admins' ? 'admins' : 'all',
      whoCanAdd: conversation.addPermission === 'admins' ? 'admins' : 'all',
      updatedAt: conversation.updatedAt,
      memberCount: members.length,
      members,
    };
  }


  /**
   * Message système (création, ajout, départ…). Il n'est jamais envoyé par un
   * client : le serveur l'insère et le diffuse comme un message normal.
   */
  async postSystemMessage(
    conversationId: string,
    actorId: string,
    content: string,
  ): Promise<MessageDto> {
    const [stored] = await this.db
      .insert(messages)
      .values({ conversationId, senderId: actorId, content, type: 'system' })
      .returning();
    const sender = await this.usersService.getByIdOrThrow(actorId);
    const message: MessageDto = {
      id: stored.id,
      conversationId,
      type: 'system',
      content,
      stickerRef: null,
      attachment: null,
      clientId: null,
      deleted: false,
      replyTo: null,
      reactions: [],
      createdAt: stored.createdAt,
      sender: {
        id: sender.id,
        username: sender.username,
        displayName: sender.displayName,
        avatarUrl: sender.avatarUrl ?? null,
        gender: sender.gender ?? null,
      },
    };
    this.events.publish({ kind: 'message', conversationId, actorId, message });
    return message;
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

  /** Réactions de plusieurs messages, agrégées pour un lecteur donné. */
  private async reactionsFor(
    messageIds: string[],
    userId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    const map = new Map<string, ReactionSummary[]>();
    if (messageIds.length === 0) {
      return map;
    }
    const rows = await this.db
      .select({
        messageId: messageReactions.messageId,
        reaction: messageReactions.reaction,
        userId: messageReactions.userId,
      })
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds));

    const perMessage = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const row of rows) {
      let byReaction = perMessage.get(row.messageId);
      if (!byReaction) {
        byReaction = new Map();
        perMessage.set(row.messageId, byReaction);
      }
      const entry = byReaction.get(row.reaction) ?? { count: 0, mine: false };
      entry.count += 1;
      if (row.userId === userId) {
        entry.mine = true;
      }
      byReaction.set(row.reaction, entry);
    }

    for (const [messageId, byReaction] of perMessage) {
      map.set(
        messageId,
        [...byReaction.entries()]
          .map(([reaction, info]) => ({ reaction, count: info.count, mine: info.mine }))
          .sort((a, b) => b.count - a.count || a.reaction.localeCompare(b.reaction)),
      );
    }
    return map;
  }

  /**
   * Ajoute ou retire une réaction. Le retour est le résumé complet du message,
   * pour que tous les appareils affichent le même état.
   */
  async toggleReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    reaction: string,
  ): Promise<ReactionSummary[]> {
    if (!isPantherReaction(reaction)) {
      throw new BadRequestException('Réaction invalide');
    }
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const [message] = await this.db
      .select({ id: messages.id, deletedAt: messages.deletedAt })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
      .limit(1);
    if (!message) {
      throw new NotFoundException('Message introuvable');
    }
    if (message.deletedAt) {
      throw new BadRequestException('Message supprimé');
    }

    const inserted = await this.db
      .insert(messageReactions)
      .values({ messageId, userId, reaction })
      .onConflictDoNothing()
      .returning({ messageId: messageReactions.messageId });
    if (inserted.length === 0) {
      await this.db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.reaction, reaction),
          ),
        );
    }

    const summaries = await this.reactionsFor([messageId], userId);
    return summaries.get(messageId) ?? [];
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

    const ordered = backwards ? rows.reverse() : rows;
    const reactions = await this.reactionsFor(
      ordered.map((row) => row.id),
      userId,
    );
    return ordered.map((row) => toMessageDto(row, reactions.get(row.id) ?? []));
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
    const reactions = await this.reactionsFor(
      rows.map((row) => row.id),
      userId,
    );
    return rows.map((row) => toMessageDto(row, reactions.get(row.id) ?? []));
  }

  /**
   * Accusés de réception des messages envoyés par `requesterId` dans cette
   * conversation. Comme WhatsApp, seul l'expéditeur voit qui a reçu et lu.
   */
  /**
   * Médias et liens d'une conversation. Les pièces jointes sont lues dans
   * l'historique (limité) ; les liens sont extraits des messages texte récents,
   * sans doublon.
   */
  async listMedia(
    conversationId: string,
    userId: string,
    limit = 60,
  ): Promise<{ attachments: ConversationMediaItem[]; links: ConversationLinkItem[] }> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const capped = Math.min(Math.max(limit, 1), 100);

    const attachmentRows = await this.db
      .select({
        messageId: messages.id,
        attachment: messages.attachment,
        createdAt: messages.createdAt,
        senderName: users.displayName,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          isNotNull(messages.attachment),
          this.hiddenFrom(userId),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(capped);

    const attachments: ConversationMediaItem[] = [];
    for (const row of attachmentRows) {
      const attachment = row.attachment;
      if (!attachment) continue;
      attachments.push({
        messageId: row.messageId,
        type: attachment.type,
        url: attachment.url,
        mime: attachment.mime,
        name: attachment.name ?? null,
        width: attachment.width,
        height: attachment.height,
        duration: attachment.duration,
        createdAt: row.createdAt,
        senderName: row.senderName,
      });
    }

    const textRows = await this.db
      .select({
        messageId: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        senderName: users.displayName,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          eq(messages.type, 'text'),
          this.hiddenFrom(userId),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(200);

    const seen = new Set<string>();
    const links: ConversationLinkItem[] = [];
    for (const row of textRows) {
      const match = /https?:\/\/[^\s<>"']+/i.exec(row.content);
      if (!match) continue;
      const url = match[0].replace(/[.,);!?]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({
        messageId: row.messageId,
        url,
        createdAt: row.createdAt,
        senderName: row.senderName,
      });
      if (links.length >= 50) break;
    }

    return { attachments, links };
  }

  /** Recherche plein texte simple dans l'historique de la conversation. */
  async searchMessages(
    conversationId: string,
    userId: string,
    query: string,
    limit = 50,
  ): Promise<ConversationSearchHit[]> {
    if (!(await this.isMember(conversationId, userId))) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    const term = query.trim();
    if (term.length === 0) {
      return [];
    }
    const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
    const rows = await this.db
      .select({
        messageId: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        senderName: users.displayName,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          this.hiddenFrom(userId),
          ilike(messages.content, `%${escaped}%`),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));

    return rows.map((row) => ({
      messageId: row.messageId,
      content: row.content,
      createdAt: row.createdAt,
      senderName: row.senderName,
    }));
  }

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
        where m.sender_id <> ${userId} and m.type not in ('call', 'system') and m.created_at <= now() ${scope}
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
    const [permissions] = await this.db
      .select({ sendPermission: conversations.sendPermission })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!permissions) {
      throw new NotFoundException('Conversation not found');
    }
    if (
      permissions.sendPermission === 'admins' &&
      (await this.roleOf(conversationId, senderId)) !== 'admin'
    ) {
      throw new ForbiddenException(
        'Seuls les administrateurs peuvent écrire dans ce groupe',
      );
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
      type: messageTypeOf(stored.type),
      content: stored.content,
      stickerRef: stored.type === 'sticker' ? (stored.stickerRef ?? null) : null,
      attachment: stored.attachment ?? null,
      clientId: stored.clientId ?? null,
      deleted: stored.deletedAt !== null,
      // Un envoi sur deux ne cite rien : on ne paie la jointure que si c'est le cas.
      replyTo: stored.replyToId ? await this.quoteOf(stored.replyToId) : null,
      reactions: [],
      createdAt: stored.createdAt,
      sender: {
        id: sender.id,
        username: sender.username,
        displayName: sender.displayName,
        avatarUrl: sender.avatarUrl,
        gender: sender.gender,
      },
    };
  }

  /**
   * Message système d'appel (« Appel vocal · 1:24 », « Appel manqué »…).
   * Réservé au serveur : aucun client ne peut envoyer ce type.
   */
  async createCallMessage(
    conversationId: string,
    senderId: string,
    content: string,
  ): Promise<MessageDto> {
    const [row] = await this.db
      .insert(messages)
      .values({ conversationId, senderId, type: 'call', content })
      .returning({ id: messages.id });
    return this.messageDto(row.id);
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
      senderGender: string | null;
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
        u.avatar_url as "senderAvatarUrl",
        u.gender as "senderGender"
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
        type: messageTypeOf(row.type),
        content: deleted ? '' : row.content,
        stickerRef: deleted || row.type !== 'sticker' ? null : (row.stickerRef ?? null),
        attachment: deleted ? null : (row.attachment ?? null),
        clientId: row.clientId ?? null,
        deleted,
        // L'aperçu d'une liste n'affiche pas la citation : jointure inutile ici.
        replyTo: null,
        // Les réactions ne servent pas dans l'aperçu de la liste.
        reactions: [],
        // Les requêtes brutes renvoient les timestamps en chaîne : on normalise en Date.
        createdAt: new Date(row.createdAt),
        sender: {
          id: row.senderId,
          username: row.senderUsername,
          displayName: row.senderDisplayName,
          avatarUrl: row.senderAvatarUrl ?? null,
          gender: row.senderGender ?? null,
        },
      });
    }
    return map;
  }
}
