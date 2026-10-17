import { API_URL } from './config';
import type {
  AuthResult,
  ConversationSummary,
  ForgotPasswordResult,
  Gender,
  Message,
  ResetPasswordResult,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token?: string;
  body?: unknown;
}

const REQUEST_TIMEOUT_MS = 15000;

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(
      0,
      `Impossible de contacter le serveur (${API_URL || 'même origine'}). Vérifie ta connexion et que l'API est démarrée.`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = (await response.json()) as { message?: string | string[] };
      if (data.message) {
        message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
      }
    } catch {
      // keep default message
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get('content-type') ?? 'type inconnu';
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new ApiError(
      0,
      `Réponse inattendue (statut ${response.status}, ${contentType}) — début : « ${preview} »`,
    );
  }
}

export const api = {
  register(body: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    birthday: string;
    gender: Gender;
  }) {
    return request<AuthResult>('/auth/register', { method: 'POST', body });
  },

  login(body: { emailOrUsername: string; password: string }) {
    return request<AuthResult>('/auth/login', { method: 'POST', body });
  },

  me(token: string) {
    return request<User>('/auth/me', { token });
  },

  forgotPassword(body: { emailOrUsername: string }) {
    return request<ForgotPasswordResult>('/auth/forgot-password', { method: 'POST', body });
  },

  resetPassword(body: { emailOrUsername: string; code: string; newPassword: string }) {
    return request<ResetPasswordResult>('/auth/reset-password', { method: 'POST', body });
  },

  searchUsers(token: string, query: string) {
    return request<User[]>(`/users/search?q=${encodeURIComponent(query)}`, { token });
  },

  listConversations(token: string) {
    return request<ConversationSummary[]>('/conversations', { token });
  },

  getConversation(token: string, id: string) {
    return request<ConversationSummary>(`/conversations/${id}`, { token });
  },

  createConversation(token: string, body: { memberIds: string[]; name?: string }) {
    return request<ConversationSummary>('/conversations', { method: 'POST', token, body });
  },

  listMessages(token: string, conversationId: string, before?: string) {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<Message[]>(`/conversations/${conversationId}/messages${query}`, { token });
  },
};
