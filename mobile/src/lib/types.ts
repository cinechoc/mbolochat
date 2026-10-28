export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Genre déclaré, pour l'avatar par défaut quand il n'y a pas de photo. */
  gender: Gender | null;
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
  /** Genre déclaré à l'inscription, pour l'avatar par défaut. */
  gender: Gender | null;
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

export type MessageAttachmentType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' | 'GIF' | 'STICKER';

/** Texte Unicode normal, ou sticker référencé par son catalogue local. */
export type MessageType = 'text' | 'sticker';

/** Pièce jointe d'un message (photo pour l'instant). */
export interface MessageAttachment {
  type: MessageAttachmentType;
  /** Chemin relatif signé et éphémère renvoyé par l'API (« /media?f=… »), ou
   *  URI locale pendant l'envoi optimiste, ou URL absolue externe (GIPHY :
   *  `https://media*.giphy.com/…`) chargée directement depuis les CDN. */
  url: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** Durée d'un message vocal, en millisecondes. */
  duration?: number;
  name?: string;
  /** GIF GIPHY : sticker animé transparent (sinon GIF plein cadre). */
  sticker?: boolean;
  /** Identifiant du GIF côté GIPHY. */
  giphyId?: string;
  /** Compte GIPHY source (attribution). */
  username?: string;
  /** Titre du GIF GIPHY. */
  title?: string;
  /** Aperçu statique remplaçant l'animation le temps du chargement. */
  stillUrl?: string;
  /** Sticker Mbolo : identifiant stable dans le catalogue. */
  stickerId?: string;
  /** Pack d'origine (catalogue local ou stickers personnels). */
  stickerPackId?: string;
  /** Nom accessible du sticker. */
  stickerName?: string;
}

/** Métadonnées envoyées avec un sticker importé comme image. */
export interface StickerSendPayload {
  id: string;
  packId: string;
  name?: string;
  /** Dimensions de l'image locale, pour un aperçu optimiste fidèle. */
  width?: number;
  height?: number;
}

/** Payload GIF GIPHY transmis du panneau à la file d'attente puis au serveur.
 *  Le serveur revalide l'URL (allowlist media*.giphy.com) avant stockage. */
export interface GifSendPayload {
  /** Rendu d'envoi (`fixed_width`, WebP) — URL GIPHY jamais altérée. */
  url: string;
  width?: number;
  height?: number;
  /** Sticker animé transparent. */
  sticker?: boolean;
  giphyId?: string;
  username?: string;
  title?: string;
  /** Aperçu statique (mêmes règles d'allowlist). */
  stillUrl?: string;
}

export interface UploadResult extends MessageAttachment {
  id: string;
}

/** Aperçu du message cité par une réponse. */
export interface MessageQuote {
  id: string;
  senderName: string;
  content: string;
  type: MessageType;
  attachmentType: MessageAttachmentType | null;
  /** L'original a été retiré depuis. */
  deleted: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  type: MessageType;
  content: string;
  /** Référence de catalogue d'un sticker (« mbolo/merci »), sinon null. */
  stickerRef: string | null;
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
  /** J'ai bloqué l'autre membre (discussion directe). */
  blockedByMe: boolean;
  /** L'autre membre m'a bloqué (discussion directe) : saisie désactivée. */
  blockedByThem: boolean;
}

export type LastSeenVisibility = 'everyone' | 'contacts' | 'nobody';
export type OnlineVisibility = 'everyone' | 'same_as_last_seen';

export interface PresenceSettings {
  lastSeenVisibility: LastSeenVisibility;
  onlineVisibility: OnlineVisibility;
}

/** Un champ absent signifie que le serveur ne l'a pas autorisé. */
export interface PresenceEntry {
  userId: string;
  online?: boolean;
  lastSeenAt?: string | null;
}

export interface PresenceSnapshot {
  serverNow: string;
  presence: PresenceEntry[];
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
