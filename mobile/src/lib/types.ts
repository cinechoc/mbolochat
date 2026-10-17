export interface SenderInfo {
  id: string;
  username: string;
  displayName: string;
}

export type Gender = 'FEMALE' | 'MALE' | 'CUSTOM';

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
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
  members: SenderInfo[];
  lastMessage: Message | null;
  unreadCount: number;
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
