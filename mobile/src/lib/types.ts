export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Membre d'une conversation, avec son dernier accusé de lecture. */
export interface MemberInfo extends SenderInfo {
  lastReadAt: string | null;
  /** Admin : il peut renommer le groupe, inviter et exclure. */
  role: 'admin' | 'member';
}

export type Gender = 'FEMALE' | 'MALE' | 'CUSTOM';

export interface User {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  /** Notifications dans l'application (badges de non-lus). */
  notificationsEnabled: boolean;
  createdAt: string;
}

/** Profil public « façon Instagram » : infos + quelques statistiques. */
export interface UserProfile extends User {
  isMe: boolean;
  stats: {
    /** Nombre de messages envoyés. */
    messages: number;
    /** Nombre de discussions partagées avec le visiteur. */
    conversations: number;
  };
}

export type MessageAttachmentType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

/** Pièce jointe d'un message (photo pour l'instant). */
export interface MessageAttachment {
  type: MessageAttachmentType;
  /** Chemin relatif signé et éphémère renvoyé par l'API (« /media?f=… »), ou
   *  URI locale pendant l'envoi optimiste. */
  url: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** Durée d'un message vocal, en millisecondes. */
  duration?: number;
  name?: string;
}

export interface UploadResult extends MessageAttachment {
  id: string;
}

/** Aperçu du message cité par une réponse. */
export interface MessageQuote {
  id: string;
  senderName: string;
  content: string;
  attachmentType: MessageAttachmentType | null;
  /** L'original a été retiré depuis. */
  deleted: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  content: string;
  attachment: MessageAttachment | null;
  /** Clé d'idempotence de l'appareil émetteur (null pour l'historique ancien). */
  clientId: string | null;
  /** Retiré pour tous : contenu et pièce jointe ne sont plus nulle part. */
  deleted: boolean;
  /** Message cité par une réponse. */
  replyTo: MessageQuote | null;
  createdAt: string;
  sender: SenderInfo;
}

/** Accusé de réception d'un message envoyé par moi, par destinataire. */
export interface MessageReceipt {
  messageId: string;
  userId: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface ConversationSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  createdAt: string;
  members: MemberInfo[];
  lastMessage: Message | null;
  unreadCount: number;
  /** Épinglée par l'utilisateur courant. */
  pinned: boolean;
  /** Muette par l'utilisateur courant. */
  muted: boolean;
  /** Masquée par l'utilisateur courant (absente de la liste principale). */
  hidden: boolean;
  /** Mon rôle : seuls les administrateurs pilotent un groupe. */
  myRole: 'admin' | 'member';
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface ForgotPasswordResult {
  message: string;
  devCode?: string;
}

export interface ResetPasswordResult {
  message: string;
}
