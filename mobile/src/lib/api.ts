import { File } from 'expo-file-system';

import { API_URL } from './config';
import type {
  AuthResult,
  ConversationSummary,
  ForgotPasswordResult,
  Gender,
  Message,
  MessageReceipt,
  PresenceSettings,
  PresenceSnapshot,
  ResetPasswordResult,
  UploadResult,
  User,
  UserProfile,
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

  updateProfile(token: string, body: { displayName?: string; bio?: string }) {
    return request<User>('/users/me', { method: 'PATCH', token, body });
  },

  getUserProfile(token: string, id: string) {
    return request<UserProfile>(`/users/${encodeURIComponent(id)}`, { token });
  },

  uploadAvatar(token: string, data: string, mimeType: string) {
    return request<User>('/users/me/avatar', { method: 'POST', token, body: { data, mimeType } });
  },

  deleteAvatar(token: string) {
    return request<User>('/users/me/avatar', { method: 'DELETE', token });
  },

  /**
   * Importe une image (multipart) et renvoie son identifiant, à joindre à un
   * message. Le corps est un FormData : React Native gère seul le boundary,
   * il ne faut donc pas fixer Content-Type.
   */
  /** Import d'un média — photo ou message vocal — avant son envoi. */
  async uploadMedia(
    token: string,
    asset: {
      uri: string;
      mimeType?: string | null;
      fileName?: string | null;
      width?: number;
      height?: number;
      durationMs?: number;
    },
    onProgress?: (fraction: number, uploadedBytes: number, totalBytes: number) => void,
  ): Promise<UploadResult> {
    const buildForm = () => {
      const form = new FormData();
      // `File` d'expo-file-system implémente Blob et lit le fichier à la
      // demande ; le boundary multipart reste géré par la plateforme.
      form.append('file', new File(asset.uri) as unknown as Blob);
      if (asset.mimeType) form.append('mime', asset.mimeType);
      if (asset.fileName) form.append('name', asset.fileName);
      if (asset.width) form.append('width', String(Math.round(asset.width)));
      if (asset.height) form.append('height', String(Math.round(asset.height)));
      if (asset.durationMs) form.append('duration', String(Math.round(asset.durationMs)));
      return form;
    };

    // XHR est le seul transport RN qui expose la progression d'un FormData.
    const post = (accessToken: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/uploads`);
        xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        xhr.timeout = 120_000;
        if (onProgress && xhr.upload) {
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && event.total > 0) {
              onProgress(event.loaded / event.total, event.loaded, event.total);
            }
          };
        }
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => reject(new Error('network'));
        xhr.ontimeout = () => reject(new Error('timeout'));
        xhr.onabort = () => reject(new Error('aborted'));
        xhr.send(buildForm());
      });

    // Certains builds natifs gèrent mal FormData/File avec XHR : le transport
    // fetch historique reste le repli sans progression.
    const postWithFetch = async (accessToken: string): Promise<UploadResult> => {
      const send = (tokenToUse: string) =>
        fetch(`${API_URL}/uploads`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenToUse}` },
          body: buildForm(),
        });
      let response = await send(accessToken);
      if (response.status === 401) {
        response = await send(await refreshAccessToken());
      }
      if (!response.ok) {
        let message = `Envoi impossible (${response.status})`;
        try {
          const data = (await response.json()) as { message?: string | string[] };
          if (data.message) {
            message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
          }
        } catch {
          // garde le message par défaut
        }
        throw new ApiError(response.status, message);
      }
      return (await response.json()) as UploadResult;
    };

    const networkError = new ApiError(
      0,
      "Impossible d'envoyer le fichier. Vérifie ta connexion.",
    );
    let result: { status: number; body: string };
    try {
      result = await post(token);
    } catch {
      try {
        return await postWithFetch(token);
      } catch (fallbackError) {
        if (fallbackError instanceof ApiError) throw fallbackError;
        throw networkError;
      }
    }
    if (result.status === 401) {
      const fresh = await refreshAccessToken();
      try {
        result = await post(fresh);
      } catch {
        throw networkError;
      }
    }
    if (result.status < 200 || result.status >= 300) {
      let message = `Envoi impossible (${result.status})`;
      try {
        const data = JSON.parse(result.body) as { message?: string | string[] };
        if (data.message) {
          message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
        }
      } catch {
        // garde le message par défaut
      }
      throw new ApiError(result.status, message);
    }
    try {
      return JSON.parse(result.body) as UploadResult;
    } catch {
      throw new ApiError(result.status, 'Réponse du serveur invalide.');
    }
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

  listMessages(
    token: string,
    conversationId: string,
    options: { before?: string; after?: string; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (options.before) params.set('before', options.before);
    if (options.after) params.set('after', options.after);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<Message[]>(`/conversations/${conversationId}/messages${query}`, { token });
  },

  /**
   * Tout ce qui est arrivé depuis un curseur, toutes discussions confondues.
   * C'est ce qui rattrape une coupure réseau. Le message servant de curseur peut
   * être renvoyé : les identifiants sont à comparer.
   */
  syncSince(token: string, since: string) {
    return request<Message[]>(`/conversations/sync?since=${encodeURIComponent(since)}`, { token });
  },

  /** Accusés de réception des messages que j'ai envoyés (coches reçue / lue). */
  listReceipts(token: string, conversationId: string) {
    return request<MessageReceipt[]>(`/conversations/${conversationId}/receipts`, { token });
  },

  markRead(token: string, conversationId: string) {
    return request<void>(`/conversations/${conversationId}/read`, { method: 'POST', token });
  },

  markAllRead(token: string) {
    return request<void>('/conversations/read-all', { method: 'POST', token });
  },

  setConversationPreferences(
    token: string,
    conversationId: string,
    body: { pinned?: boolean; muted?: boolean; hidden?: boolean },
  ) {
    return request<ConversationSummary>(`/conversations/${conversationId}/preferences`, {
      method: 'PATCH',
      token,
      body,
    });
  },

  listHiddenConversations(token: string) {
    return request<ConversationSummary[]>('/conversations/hidden', { token });
  },

  listBlockedUsers(token: string) {
    return request<User[]>('/users/blocked', { token });
  },

  blockUser(token: string, id: string) {
    return request<{ blocked: boolean }>(`/users/${encodeURIComponent(id)}/block`, {
      method: 'POST',
      token,
    });
  },

  unblockUser(token: string, id: string) {
    return request<{ blocked: boolean }>(`/users/${encodeURIComponent(id)}/block`, {
      method: 'DELETE',
      token,
    });
  },

  setNotificationsEnabled(token: string, enabled: boolean) {
    return this.setNotificationPreferences(token, { notificationsEnabled: enabled });
  },

  setNotificationPreferences(
    token: string,
    prefs: {
      notificationsEnabled?: boolean;
      notificationSound?: boolean;
      notificationPreview?: boolean;
    },
  ) {
    return request<User>('/users/me', {
      method: 'PATCH',
      token,
      body: prefs,
    });
  },

  registerPushToken(token: string, pushToken: string, platform = 'android') {
    return request<{ registered: boolean }>('/users/me/push-token', {
      method: 'POST',
      token,
      body: { token: pushToken, platform, apiBaseUrl: API_URL },
    });
  },

  removePushToken(token: string, pushToken: string) {
    return request<{ registered: boolean }>('/users/me/push-token', {
      method: 'DELETE',
      token,
      body: { token: pushToken },
    });
  },

  getPresenceSettings(token: string) {
    return request<PresenceSettings>('/me/presence-settings', { token });
  },

  updatePresenceSettings(token: string, body: Partial<PresenceSettings>) {
    return request<PresenceSettings>('/me/presence-settings', {
      method: 'PATCH',
      token,
      body,
    });
  },

  getPresence(token: string, ids: string[]) {
    return request<PresenceSnapshot>(
      `/presence?ids=${encodeURIComponent(ids.join(','))}`,
      { token },
    );
  },
};