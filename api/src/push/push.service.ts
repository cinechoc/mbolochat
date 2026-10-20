import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, inArray, or } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  blocks,
  conversationMembers,
  conversations,
  pushTokens,
  users,
} from '../db/schema.js';
import type { MessageDto } from '../conversations/conversations.service.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** L'API Expo accepte au maximum 100 messages par requête. */
const BATCH_SIZE = 100;
/** Canal Android déclaré par l'application (importance haute). */
const CHANNEL_ID = 'messages';

interface ExpoTicket {
  status?: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  priority: 'high';
  channelId: string;
  /** Photo de profil de l'expéditeur, utilisée comme grande icône Android. */
  richContent?: { image: string };
  data: {
    type: 'message';
    conversationId: string;
    messageId: string;
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

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async notifyNewMessage(message: MessageDto, activeUserIds: string[] = []): Promise<void> {
    try {
      const [conversation] = await this.db
        .select({
          type: conversations.type,
          name: conversations.name,
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
          notificationsEnabled: users.notificationsEnabled,
        })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .where(eq(conversationMembers.conversationId, message.conversationId));

      const active = new Set(activeUserIds);
      const candidates = members
        .filter(
          (member) =>
            member.userId !== message.sender.id &&
            member.notificationsEnabled &&
            member.mutedAt === null &&
            !active.has(member.userId),
        )
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
        .select({ token: pushTokens.token, baseUrl: pushTokens.baseUrl })
        .from(pushTokens)
        .where(inArray(pushTokens.userId, recipients));
      if (tokens.length === 0) {
        return;
      }

      const title =
        conversation.type === 'GROUP'
          ? (conversation.name?.trim() || 'Groupe')
          : message.sender.displayName;
      const text = previewOf(message.content);
      const body = conversation.type === 'GROUP' ? `${message.sender.displayName} : ${text}` : text;

      const avatarPath = message.sender.avatarUrl;

      const payload: ExpoPushMessage[] = tokens.map(({ token, baseUrl }) => {
        const avatar = avatarPath ? absoluteMediaUrl(avatarPath, baseUrl) : null;
        return {
          to: token,
          title,
          body,
          sound: 'default',
          priority: 'high',
          channelId: CHANNEL_ID,
          ...(avatar ? { richContent: { image: avatar } } : {}),
          data: {
            type: 'message',
            conversationId: message.conversationId,
            messageId: message.id,
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

  private async send(payload: ExpoPushMessage[]): Promise<void> {
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
