import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  blocks,
  conversationMembers,
  conversations,
  pushTokens,
  users,
} from '../db/schema.js';
import type { MessageDto } from '../conversations/conversations.service.js';
import { MediaService } from '../media/media.service.js';
import { PresenceService } from '../presence/presence.service.js';
import {
  mentionsUser,
  messageNotificationAllowed,
  quietHoursActive,
} from './notification-policy.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** L'API Expo accepte au maximum 100 messages par requête. */
const BATCH_SIZE = 100;

interface ExpoTicket {
  status?: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Notification « data-only » : elle n'est pas affichée par le système, c'est
 * l'application (MessagingNotificationService côté Android) qui la construit,
 * pour obtenir le rendu WhatsApp (avatar rond + badge du logo).
 */
interface ExpoPushMessage {
  to: string;
  priority: 'high';
  /** Expiration courte pour les appels (une sonnerie périmée ne sert à rien). */
  ttl?: number;
  /** Canal Android (les appels ont leur propre canal prioritaire). */
  channelId?: string;
  data: {
    type: 'message';
    title: string;
    message: string;
    conversationId: string;
    messageId: string;
    senderName: string;
    /** URL absolue de la photo de l'expéditeur (vide s'il n'en a pas). */
    avatarUrl: string;
    /** Nom du groupe (vide pour une discussion directe). */
    groupName: string;
    /** URL absolue de la photo du groupe (vide s'il n'y en a pas). */
    groupAvatarUrl: string;
    /** Emoji d'identité du groupe (vide pour une discussion directe). */
    groupEmoji: string;
    /** Nombre de non-lus de la conversation pour ce destinataire. */
    unreadCount: string;
    /** « 1 » : notification silencieuse (préférence du compte). */
    silent: string;
  };
}

/** Notification d'appel entrant : traitée par le service Android plein écran. */
interface ExpoCallPushMessage {
  to: string;
  priority: 'high';
  ttl: number;
  channelId: 'calls';
  data: {
    type: 'call';
    callId: string;
    conversationId: string;
    title: string;
    senderName: string;
    avatarUrl: string;
    /** « 1 » : appel vidéo, pour le libellé de la notification. */
    video: string;
  };
}

/** Annulation / appel manqué : data-only, sans interface système. */
interface ExpoCallUpdateMessage {
  to: string;
  priority: 'high';
  data: {
    type: 'call-cancel' | 'call-missed';
    callId: string;
    conversationId: string;
    title: string;
    video: string;
  };
}

/**
 * URL absolue d'une image de l'API, joignable depuis l'appareil.
 * Les avatars sont stockés en chemin relatif (« /uploads/… ») : c'est
 * l'appareil qui indique l'adresse par laquelle il joint l'API.
 */
function absoluteMediaUrl(path: string, baseUrl: string | null): string | null {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Aperçu court du message pour la notification. */
function previewOf(content: string): string {
  const single = content.replace(/\s+/g, ' ').trim();
  return single.length > 160 ? `${single.slice(0, 157)}…` : single;
}

/** Texte affiché dans la notification, selon le type et la pièce jointe. */
export function notificationText(
  message: Pick<MessageDto, 'type' | 'content' | 'attachment'>,
  preview = true,
): string {
  if (!preview) {
    return 'Nouveau message';
  }
  if (message.type === 'sticker') {
    return 'Sticker';
  }
  if (!message.attachment) {
    return previewOf(message.content);
  }
  if (message.content) {
    return previewOf(message.content);
  }
  switch (message.attachment.type) {
    case 'AUDIO':
      return '🎤 Message vocal';
    case 'VIDEO':
      return '🎬 Vidéo';
    case 'FILE':
      return '📎 Fichier';
    case 'GIF':
      return '🎞️ GIF';
    case 'STICKER':
      return '✨ Sticker';
    default:
      return '📷 Photo';
  }
}

/**
 * Envoi des notifications push des nouveaux messages via le service Expo.
 *
 * Les destinataires sont filtrés comme sur WhatsApp :
 * - l'expéditeur n'est jamais notifié ;
 * - les comptes ayant coupé les notifications ou mis la discussion en
 *   sourdine ne reçoivent rien ;
 * - les comptes bloqués (dans un sens ou dans l'autre) sont ignorés ;
 * - les membres qui ont la conversation ouverte au même instant sont
 *   ignorés (ils voient déjà le message arriver).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly media: MediaService,
    private readonly presence: PresenceService,
  ) {}

  async notifyNewMessage(message: MessageDto, activeUserIds: string[] = []): Promise<void> {
    try {
      const [conversation] = await this.db
        .select({
          type: conversations.type,
          name: conversations.name,
          avatarUrl: conversations.avatarUrl,
          emoji: conversations.emoji,
        })
        .from(conversations)
        .where(eq(conversations.id, message.conversationId))
        .limit(1);
      if (!conversation) {
        return;
      }

      const members = await this.db
        .select({
          userId: conversationMembers.userId,
          mutedAt: conversationMembers.mutedAt,
          username: users.username,
          notificationsEnabled: users.notificationsEnabled,
          notificationSound: users.notificationSound,
          notificationPreview: users.notificationPreview,
          notifyMessages: users.notifyMessages,
          notifyGroups: users.notifyGroups,
          notifyMentions: users.notifyMentions,
          notifyReactions: users.notifyReactions,
          quietHoursEnabled: users.quietHoursEnabled,
          quietStartMinute: users.quietStartMinute,
          quietEndMinute: users.quietEndMinute,
          quietUtcOffsetMinutes: users.quietUtcOffsetMinutes,
        })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .where(eq(conversationMembers.conversationId, message.conversationId));

      const isGroup = conversation.type === 'GROUP';
      const active = new Set(activeUserIds);
      const now = new Date();
      const candidates = members
        .filter((member) => {
          if (
            member.userId === message.sender.id ||
            !member.notificationsEnabled ||
            member.mutedAt !== null ||
            // App au premier plan (même sur un autre écran) : pas de push.
            this.presence.isOnline(member.userId) ||
            active.has(member.userId)
          ) {
            return false;
          }
          const mention = isGroup && mentionsUser(message.content ?? '', member.username);
          if (
            !messageNotificationAllowed({
              isGroup,
              mention,
              notifyMessages: member.notifyMessages,
              notifyGroups: member.notifyGroups,
              notifyMentions: member.notifyMentions,
            })
          ) {
            return false;
          }
          return !quietHoursActive(
            member.quietHoursEnabled,
            member.quietStartMinute,
            member.quietEndMinute,
            member.quietUtcOffsetMinutes,
            now,
          );
        })
        .map((member) => member.userId);
      if (candidates.length === 0) {
        return;
      }

      // Un blocage, dans un sens ou dans l'autre, coupe aussi les alertes.
      const blockRows = await this.db
        .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
        .from(blocks)
        .where(or(eq(blocks.blockerId, message.sender.id), eq(blocks.blockedId, message.sender.id)));
      const blocked = new Set<string>();
      for (const row of blockRows) {
        blocked.add(row.blockerId === message.sender.id ? row.blockedId : row.blockerId);
      }

      const recipients = candidates.filter((userId) => !blocked.has(userId));
      if (recipients.length === 0) {
        return;
      }

      const tokens = await this.db
        .select({ userId: pushTokens.userId, token: pushTokens.token, baseUrl: pushTokens.baseUrl })
        .from(pushTokens)
        .where(inArray(pushTokens.userId, recipients));
      if (tokens.length === 0) {
        return;
      }

      // Compteur par conversation : même règle que les pastilles de l'app.
      const unreadRows = await this.db.execute<{ userId: string; cnt: number }>(sql`
        select cm.user_id as "userId", count(m.id)::int as "cnt"
        from conversation_members cm
        left join messages m on m.conversation_id = cm.conversation_id
          and m.sender_id <> cm.user_id
          and m.type not in ('call', 'system')
          and (cm.last_read_at is null or m.created_at > cm.last_read_at)
          and not exists (
            select 1 from message_hides mh
            where mh.message_id = m.id and mh.user_id = cm.user_id
          )
        where cm.conversation_id = ${message.conversationId}
          and cm.user_id in (${sql.join(recipients.map((id) => sql`${id}`), sql`, `)})
        group by cm.user_id
      `);
      const unreadByUser = new Map(unreadRows.rows.map((row) => [row.userId, Number(row.cnt)]));
      const prefsByUser = new Map(members.map((member) => [member.userId, member]));

      const groupLabel = conversation.name?.trim() || 'Groupe';
      const title = isGroup
        ? conversation.emoji
          ? `${conversation.emoji} ${groupLabel}`
          : groupLabel
        : message.sender.displayName;

      // L'avatar part en URL absolue dans la notification : il doit être signé
      // ici aussi, la notification ne passe pas par la réponse HTTP.
      const avatarPath = this.media.signOrNull(message.sender.avatarUrl);
      const groupAvatarPath = isGroup
        ? this.media.signOrNull(conversation.avatarUrl)
        : null;
      const groupName = isGroup ? title : '';

      const payload: ExpoPushMessage[] = tokens.map(({ userId, token, baseUrl }) => {
        const prefs = prefsByUser.get(userId);
        // Aperçus coupés : le texte du message ne quitte jamais le serveur.
        const text = notificationText(message, prefs?.notificationPreview ?? true);
        const body = conversation.type === 'GROUP' ? `${message.sender.displayName} : ${text}` : text;
        const avatar = avatarPath ? absoluteMediaUrl(avatarPath, baseUrl) : null;
        const groupAvatar = groupAvatarPath ? absoluteMediaUrl(groupAvatarPath, baseUrl) : null;
        return {
          to: token,
          priority: 'high',
          data: {
            type: 'message',
            title,
            message: body,
            conversationId: message.conversationId,
            messageId: message.id,
            senderName: message.sender.displayName,
            avatarUrl: avatar ?? '',
            groupName,
            groupAvatarUrl: groupAvatar ?? '',
            groupEmoji: isGroup ? (conversation.emoji ?? '') : '',
            unreadCount: String(Math.max(1, unreadByUser.get(userId) ?? 1)),
            silent: prefs?.notificationSound === false ? '1' : '0',
          },
        };
      });

      await this.send(payload);
    } catch (error) {
      // Une notification manquée ne doit jamais faire échouer l'envoi du message.
      this.logger.warn(
        `Notification non envoyée pour ${message.conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Appel entrant : le canal « calls » et la notification plein écran sont
   * construits par MessagingNotificationService (Android). Les appels ignorent
   * les préférences muet/notifications : un appel sonne toujours.
   */
  async notifyIncomingCall(input: {
    callId: string;
    conversationId: string;
    calleeId: string;
    callerName: string;
    callerAvatarUrl: string | null;
    video: boolean;
  }): Promise<void> {
    try {
      const [callee] = await this.db
        .select({ notifyCalls: users.notifyCalls })
        .from(users)
        .where(eq(users.id, input.calleeId))
        .limit(1);
      // Les heures calmes ne coupent pas les appels ; la catégorie « appels »
      // les coupe, comme les autres notifications hors application.
      if (!callee?.notifyCalls) {
        return;
      }
      const tokens = await this.db
        .select({ token: pushTokens.token, baseUrl: pushTokens.baseUrl })
        .from(pushTokens)
        .where(eq(pushTokens.userId, input.calleeId));
      if (tokens.length === 0) {
        return;
      }
      const avatarPath = this.media.signOrNull(input.callerAvatarUrl);
      const payload: ExpoCallPushMessage[] = tokens.map(({ token, baseUrl }) => ({
        to: token,
        priority: 'high',
        ttl: 30,
        channelId: 'calls',
        data: {
          type: 'call',
          callId: input.callId,
          conversationId: input.conversationId,
          title: input.callerName,
          senderName: input.callerName,
          avatarUrl: (avatarPath ? absoluteMediaUrl(avatarPath, baseUrl) : null) ?? '',
          video: input.video ? '1' : '0',
        },
      }));
      await this.send(payload);
    } catch (error) {
      this.logger.warn(
        `Notification d'appel non envoyée pour ${input.callId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Réaction ajoutée à un de mes messages : notification discrète, soumise à
   * la catégorie « réactions », à la sourdine et aux heures calmes.
   */
  async notifyReaction(input: {
    conversationId: string;
    messageId: string;
    reaction: string;
    authorId: string;
    reactor: { id: string; displayName: string; avatarUrl: string | null };
  }): Promise<void> {
    try {
      if (input.authorId === input.reactor.id) {
        return;
      }
      const [conversation] = await this.db
        .select({
          type: conversations.type,
          name: conversations.name,
          avatarUrl: conversations.avatarUrl,
          emoji: conversations.emoji,
        })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      if (!conversation) {
        return;
      }
      const [author] = await this.db
        .select({
          mutedAt: conversationMembers.mutedAt,
          notificationsEnabled: users.notificationsEnabled,
          notificationSound: users.notificationSound,
          notifyReactions: users.notifyReactions,
          quietHoursEnabled: users.quietHoursEnabled,
          quietStartMinute: users.quietStartMinute,
          quietEndMinute: users.quietEndMinute,
          quietUtcOffsetMinutes: users.quietUtcOffsetMinutes,
        })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .where(
          and(
            eq(conversationMembers.conversationId, input.conversationId),
            eq(conversationMembers.userId, input.authorId),
          ),
        )
        .limit(1);
      if (
        !author ||
        !author.notificationsEnabled ||
        !author.notifyReactions ||
        author.mutedAt !== null ||
        this.presence.isOnline(input.authorId) ||
        quietHoursActive(
          author.quietHoursEnabled,
          author.quietStartMinute,
          author.quietEndMinute,
          author.quietUtcOffsetMinutes,
        )
      ) {
        return;
      }
      const [block] = await this.db
        .select({ blockerId: blocks.blockerId })
        .from(blocks)
        .where(
          or(
            and(
              eq(blocks.blockerId, input.reactor.id),
              eq(blocks.blockedId, input.authorId),
            ),
            and(
              eq(blocks.blockerId, input.authorId),
              eq(blocks.blockedId, input.reactor.id),
            ),
          ),
        )
        .limit(1);
      if (block) {
        return;
      }
      const tokens = await this.db
        .select({ token: pushTokens.token, baseUrl: pushTokens.baseUrl })
        .from(pushTokens)
        .where(eq(pushTokens.userId, input.authorId));
      if (tokens.length === 0) {
        return;
      }
      const isGroup = conversation.type === 'GROUP';
      const groupLabel = conversation.name?.trim() || 'Groupe';
      const title = isGroup
        ? conversation.emoji
          ? `${conversation.emoji} ${groupLabel}`
          : groupLabel
        : input.reactor.displayName;
      const text = isGroup
        ? `${input.reactor.displayName} a réagi ${input.reaction} à votre message`
        : `A réagi ${input.reaction} à votre message`;
      const avatarPath = this.media.signOrNull(input.reactor.avatarUrl);
      const groupAvatarPath = isGroup ? this.media.signOrNull(conversation.avatarUrl) : null;
      const payload: ExpoPushMessage[] = tokens.map(({ token, baseUrl }) => ({
        to: token,
        priority: 'high',
        data: {
          type: 'message',
          title,
          message: text,
          conversationId: input.conversationId,
          messageId: input.messageId,
          senderName: input.reactor.displayName,
          avatarUrl: (avatarPath ? absoluteMediaUrl(avatarPath, baseUrl) : null) ?? '',
          groupName: isGroup ? title : '',
          groupAvatarUrl: (groupAvatarPath ? absoluteMediaUrl(groupAvatarPath, baseUrl) : null) ?? '',
          groupEmoji: isGroup ? (conversation.emoji ?? '') : '',
          unreadCount: '0',
          silent: author.notificationSound === false ? '1' : '0',
        },
      }));
      await this.send(payload);
    } catch (error) {
      this.logger.warn(
        `Notification de réaction non envoyée pour ${input.conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * L'appel n'est plus en sonnerie : les appareils de l'appelé ferment la
   * notification plein écran, puis affichent « Appel manqué » si besoin.
   */
  async notifyCallUpdate(input: {
    calleeId: string;
    callId: string;
    conversationId: string;
    callerName: string;
    video: boolean;
    outcome: 'cancelled' | 'missed';
  }): Promise<void> {
    try {
      const tokens = await this.db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(eq(pushTokens.userId, input.calleeId));
      if (tokens.length === 0) {
        return;
      }
      const payload: ExpoCallUpdateMessage[] = tokens.map(({ token }) => ({
        to: token,
        priority: 'high',
        data: {
          type: input.outcome === 'missed' ? 'call-missed' : 'call-cancel',
          callId: input.callId,
          conversationId: input.conversationId,
          title: input.callerName,
          video: input.video ? '1' : '0',
        },
      }));
      await this.send(payload);
    } catch (error) {
      this.logger.warn(
        `Mise à jour d'appel non envoyée pour ${input.callId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async send(
    payload: Array<ExpoPushMessage | ExpoCallPushMessage | ExpoCallUpdateMessage>,
  ): Promise<void> {
    const deadTokens: string[] = [];

    for (let offset = 0; offset < payload.length; offset += BATCH_SIZE) {
      const batch = payload.slice(offset, offset + BATCH_SIZE);
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(`Expo Push a répondu ${response.status}`);
        continue;
      }

      const result = (await response.json()) as { data?: ExpoTicket[] };
      const tickets = result.data ?? [];
      tickets.forEach((ticket, index) => {
        const token = batch[index]?.to;
        if (!token) {
          return;
        }
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(token);
          return;
        }
        if (ticket.status === 'error') {
          this.logger.warn(`Push refusé (${ticket.details?.error ?? ticket.message ?? 'inconnu'})`);
        }
      });
    }

    if (deadTokens.length > 0) {
      await this.db.delete(pushTokens).where(inArray(pushTokens.token, deadTokens));
    }
  }
}
