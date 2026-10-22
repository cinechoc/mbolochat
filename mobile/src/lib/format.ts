import type { ConversationSummary, MessageReceipt } from './types';

export function conversationTitle(conversation: ConversationSummary, currentUserId: string): string {
  if (conversation.name) {
    return conversation.name;
  }
  const others = conversation.members.filter((member) => member.id !== currentUserId);
  if (others.length === 0) {
    return 'Discussion';
  }
  return others.map((member) => member.displayName).join(', ');
}

// Formatage manuel plutôt qu'Intl : `toLocaleTimeString`/`toLocaleDateString`
// construisent un formateur à chaque appel, ce qui coûte cher sur les
// appareils d'entrée de gamme (30 messages = 60 formats à l'ouverture).
const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

const pad = (value: number) => (value < 10 ? `0${value}` : String(value));

const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function daysAgo(date: Date): number {
  return Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (daysAgo(date) <= 0) {
    return clock(date);
  }
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

export function formatListTimestamp(iso: string): string {
  const date = new Date(iso);
  const days = daysAgo(date);

  if (days <= 0) {
    return clock(date);
  }
  if (days === 1) {
    return 'Hier';
  }
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${pad(date.getFullYear() % 100)}`;
}

export function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  const days = daysAgo(date);

  if (days <= 0) {
    return "Aujourd'hui";
  }
  if (days === 1) {
    return 'Hier';
  }
  const year =
    date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

/** Filtres de la liste de discussions. */
export type ConversationFilter = 'all' | 'unread' | 'groups';

/** Étiquette de section pour regrouper les discussions par ancienneté. */
export function conversationSectionLabel(iso: string): string {
  const days = daysAgo(new Date(iso));

  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  if (days <= 7) return '7 derniers jours';
  return 'Plus ancien';
}

/** Le message a-t-il été lu par tous les autres membres de la conversation ? */
export function isReadByOthers(
  conversation: ConversationSummary,
  currentUserId: string,
  messageCreatedAt: string,
): boolean {
  const others = conversation.members.filter((member) => member.id !== currentUserId);
  if (others.length === 0) {
    return false;
  }
  const sentAt = new Date(messageCreatedAt).getTime();
  return others.every(
    (member) => member.lastReadAt !== null && new Date(member.lastReadAt).getTime() >= sentAt,
  );
}

/** État de la coche d'un message que j'ai envoyé. */
export type TickState = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

/**
 * Coche d'un de mes messages, d'après les accusés réellement reçus du serveur.
 *
 * `receipts` ne contient que ceux des autres membres. Rien n'est revenu : le
 * message est seulement parti — pas de supposition sur les messages antérieurs à
 * l'arrivée des accusés de réception. Tous l'ont reçu : double coche grise. Tous
 * l'ont lu : double coche bleue. Dans un groupe, on reste gris tant qu'un seul
 * n'a pas lu, comme WhatsApp.
 */
export function tickState(receipts: MessageReceipt[]): TickState {
  if (receipts.length === 0) {
    return 'sent';
  }
  const delivered = receipts.filter((receipt) => receipt.deliveredAt !== null).length;
  const read = receipts.filter((receipt) => receipt.readAt !== null).length;
  if (read === receipts.length) {
    return 'read';
  }
  if (delivered > 0) {
    return 'delivered';
  }
  return 'sent';
}

export interface ConversationPreview {
  /** Texte affiché sous le titre de la discussion. */
  text: string;
  /** Le dernier message a-t-il été envoyé par l'utilisateur courant ? */
  mine: boolean;
  /** Les autres ont-ils lu le dernier message ? */
  read: boolean;
}

/** Aperçu du dernier message ; les icônes (coche, média) sont rendues par la ligne. */
export function conversationPreview(
  conversation: ConversationSummary,
  currentUserId: string,
): ConversationPreview {
  const last = conversation.lastMessage;
  if (!last) {
    return { text: 'Nouvelle conversation', mine: false, read: false };
  }

  const mine = last.sender.id === currentUserId;
  const isGroup = conversation.type === 'GROUP';
  const body = last.deleted
    ? 'Message supprimé'
    : last.attachment
      ? last.content
        ? last.content
        : last.attachment.type === 'AUDIO'
          ? 'Message vocal'
          : last.attachment.type === 'IMAGE'
            ? 'Photo'
            : 'Pièce jointe'
      : last.content;
  if (mine) {
    const read = isReadByOthers(conversation, currentUserId, last.createdAt);
    return { text: isGroup ? `Vous : ${body}` : body, mine, read };
  }
  return {
    text: isGroup ? `${last.sender.displayName} : ${body}` : body,
    mine,
    read: false,
  };
}
