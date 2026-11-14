import type { StoredE2eeMessage } from '@/features/e2ee/db';
import { decodeMediaMeta } from '@/features/e2ee/payload';
import type { Message, ReactionSummary, SenderInfo } from '@/lib/types';
import type {
  ChatAttachmentView,
  ChatDeliveryState,
  ChatIdentity,
  ChatMessageView,
} from '@/features/chat/transport/types';

/** Identité normalisée, depuis un membre ou l'utilisateur courant. */
export function identityOf(input: {
  id: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  gender?: SenderInfo['gender'];
  genderCustom?: string | null;
}): ChatIdentity {
  return {
    id: input.id,
    username: input.username ?? '',
    displayName: input.displayName ?? input.username ?? '',
    avatarUrl: input.avatarUrl ?? null,
    gender: input.gender ?? null,
    genderCustom: input.genderCustom ?? null,
  };
}

function classicAttachment(message: Message): ChatAttachmentView | null {
  const attachment = message.attachment;
  if (!attachment) {
    return null;
  }
  return {
    type: attachment.type,
    url: attachment.url,
    encrypted: false,
    mediaMeta: null,
    mime: attachment.mime ?? null,
    name: attachment.name ?? null,
    size: attachment.size ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    durationMs: attachment.duration ?? null,
    stickerId: attachment.stickerId ?? null,
    stickerPackId: attachment.stickerPackId ?? null,
    stickerName: attachment.stickerName ?? null,
    giphy:
      attachment.type === 'GIF'
        ? {
            giphyId: attachment.giphyId ?? null,
            username: attachment.username ?? null,
            title: attachment.title ?? null,
            stillUrl: attachment.stillUrl ?? null,
            sticker: attachment.sticker === true,
          }
        : null,
  };
}

/** Message classique (serveur, cache ou bulle optimiste) → vue unifiée. */
export function classicMessageToView(
  message: Message,
  options: {
    currentUserId: string;
    state?: ChatDeliveryState;
    error?: string | null;
    progress?: number | null;
  },
): ChatMessageView {
  const mine = message.sender.id === options.currentUserId;
  return {
    id: message.id,
    clientId: message.clientId,
    conversationId: message.conversationId,
    mine,
    sender: identityOf(message.sender),
    createdAt: message.createdAt,
    body: message.deleted ? '' : message.content,
    type: message.type ?? 'text',
    deleted: message.deleted,
    unreadable: false,
    edited: false,
    editRevision: 0,
    quoteId: message.replyTo?.id ?? null,
    quote: message.replyTo,
    reactions: message.reactions ?? [],
    stickerRef: message.stickerRef,
    attachment: classicAttachment(message),
    state: options.state ?? (mine ? 'sent' : 'none'),
    error: options.error ?? null,
    progress: options.progress ?? null,
  };
}

/** Message de la base chiffrée → vue unifiée (aucun clair hors SQLCipher). */
export function storedMessageToView(
  stored: StoredE2eeMessage,
  options: {
    currentUser: ChatIdentity;
    peer: ChatIdentity;
    state?: ChatDeliveryState;
    reactions?: ReactionSummary[];
  },
): ChatMessageView {
  const mine = stored.mine === 1;
  const media = stored.media_meta ? decodeMediaMeta(stored.media_meta) : null;
  const deleted = stored.deleted === 1;
  const sender = mine
    ? options.currentUser
    : {
        ...options.peer,
        displayName: stored.sender_name || options.peer.displayName,
      };
  const attachment: ChatAttachmentView | null = media && !deleted
    ? {
        type: media.type,
        url: null,
        encrypted: true,
        mediaMeta: stored.media_meta,
        mime: media.mime,
        name: media.name ?? null,
        size: null,
        width: media.width ?? null,
        height: media.height ?? null,
        durationMs: media.duration ?? null,
        stickerId: null,
        stickerPackId: null,
        stickerName: null,
        giphy: null,
      }
    : null;
  return {
    id: stored.id,
    clientId: stored.client_id,
    conversationId: stored.conversation_id,
    mine,
    sender,
    createdAt: stored.created_at,
    body: deleted ? '' : stored.body,
    type: 'text',
    deleted,
    unreadable: !deleted && Boolean(stored.unreadable_reason),
    edited: !deleted && (stored.edit_revision ?? 0) > 0,
    editRevision: deleted ? 0 : (stored.edit_revision ?? 0),
    quoteId: deleted ? null : stored.quote_id,
    // La citation chiffrée est reconstruite depuis l'index local par l'écran :
    // seule la référence traverse la couche de données.
    quote: null,
    reactions: deleted ? [] : options.reactions ?? [],
    stickerRef: deleted ? null : stored.sticker_ref ?? null,
    attachment,
    state: options.state ?? 'none',
    error: null,
    progress: null,
  };
}
