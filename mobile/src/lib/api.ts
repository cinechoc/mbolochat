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
  _retried?: boolean;
}

const REQUEST_TIMEOUT_MS = 15000;

let refreshInFlight: Promise<string> | null = null;

async function doRefresh(refreshToken: string): Promise<string> {
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'Refresh failed');
  }
  const data = (await response.json()) as { accessToken: string; refreshToken?: string };
  // update stored refresh if rotated
  const { getStoredRefreshToken, storeTokens } = await import('./token-storage');
  const currentRefresh = (await getStoredRefreshToken()) ?? refreshToken;
  await storeTokens(data.accessToken, data.refreshToken ?? currentRefresh);
  return data.accessToken;
}

export async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const { getStoredRefreshToken } = await import('./token-storage');
      const rt = await getStoredRefreshToken();
      if (!rt) throw new ApiError(401, 'No refresh token');
      return await doRefresh(rt);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

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
    clearTimeout(timeout);
    throw new ApiError(
      0,
      `Impossible de contacter le serveur (${API_URL || 'même origine'}). Vérifie ta connexion et que l'API est démarrée.`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 && !options._retried && path !== '/auth/refresh' && path !== '/auth/login' && path !== '/auth/register') {
    try {
      const newToken = await refreshAccessToken();
      return request<T>(path, { ...options, token: newToken, _retried: true });
    } catch {
      // fall through to throw original
    }
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

  refresh(refreshToken: string) {
    return request<{ accessToken: string; refreshToken?: string }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    });
  },

  logout(refreshToken: string | undefined, token?: string) {
    return request<void>('/auth/logout', { method: 'POST', token, body: { refreshToken } });
  },

  me(token: string) {
    return request<User>('/auth/me', { token });
  },

  updateProfile(token: string, body: { displayName?: string }) {
    return request<User>('/users/me', { method: 'PATCH', token, body });
  },

  uploadAvatar(token: string, data: string, mimeType: string) {
    return request<User>('/users/me/avatar', { method: 'POST', token, body: { data, mimeType } });
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

  createConversation(token: string, body: { memberIds: string[]; name?: string; type?: 'DIRECT' | 'GROUP' }) {
    return request<ConversationSummary>('/conversations', { method: 'POST', token, body });
  },

  renameConversation(token: string, id: string, name: string) {
    return request<ConversationSummary>(`/conversations/${id}`, { method: 'PATCH', token, body: { name } });
  },

  addConversationMembers(token: string, id: string, memberIds: string[]) {
    return request<ConversationSummary>(`/conversations/${id}/members`, { method: 'POST', token, body: { memberIds } });
  },

  removeConversationMember(token: string, id: string, userId: string) {
    return request<void>(`/conversations/${id}/members/${userId}`, { method: 'DELETE', token });
  },

  listMessages(token: string, conversationId: string, before?: string, limit?: number) {
    const params = new URLSearchParams();
    if (before) params.set('before', before);
    if (limit) params.set('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<Message[]>(`/conversations/${conversationId}/messages${query}`, { token });
  },
};