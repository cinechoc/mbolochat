export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Membre d'une conversation, avec son dernier accusé de lecture. */
export interface MemberInfo extends SenderInfo {
  lastReadAt: string | null;
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

export interface Message {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  sender: SenderInfo;
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
