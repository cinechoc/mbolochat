import { io, type Socket } from 'socket.io-client';

import { refreshAccessToken } from './api';
import { API_URL } from './config';
import { getCachedAccessToken } from './token-storage';

let socket: Socket | null = null;
/** Un seul rafraîchissement de jeton à la fois, même si plusieurs
 *  reconnexions échouent en parallèle. */
let authRefreshInFlight: Promise<void> | null = null;
/** L'app a besoin de savoir si elle est connectée (bandeau, reprise des envois). */
const connectionListeners = new Set<(connected: boolean) => void>();

function notifyConnection(connected: boolean): void {
  for (const listener of connectionListeners) {
    listener(connected);
  }
}

/**
 * Le serveur ferme la connexion quand le jeton est expiré (ou au redémarrage
 * de l'API, qui réauthentifie tout le monde). Dans ce cas Socket.IO ne se
 * reconnecte pas tout seul : on rafraîchit le jeton puis on relance la
 * connexion, sinon le socket resterait muet jusqu'au prochain lancement.
 */
function reconnectWithFreshToken(current: Socket): Promise<void> {
  if (!authRefreshInFlight) {
    authRefreshInFlight = (async () => {
      try {
        const token = await refreshAccessToken();
        current.auth = { token };
        current.connect();
      } catch {
        // Pas de jeton valide : l'écran d'authentification reprendra la main.
      } finally {
        authRefreshInFlight = null;
      }
    })();
  }
  return authRefreshInFlight;
}

function createSocket(token: string): Socket {
  const created = io(API_URL || undefined, {
    auth: { token },
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    withCredentials: true,
  });
  created.on('connect', () => {
    notifyConnection(true);
  });
  created.on('disconnect', (reason) => {
    notifyConnection(false);
    if (reason === 'io server disconnect') {
      void reconnectWithFreshToken(created);
    }
  });
  created.on('connect_error', () => {
    notifyConnection(false);
    void reconnectWithFreshToken(created);
  });
  return created;
}

export function connectSocket(token: string): Socket {
  // Le jeton stocké est souvent plus récent que celui affiché par l'écran :
  // un refresh (401 sur l'API) met à jour le stockage, pas l'état React.
  const current = getCachedAccessToken() ?? token;
  if (!socket) {
    socket = createSocket(current);
    return socket;
  }
  const auth = socket.auth as { token?: string } | undefined;
  if (auth?.token !== current) {
    socket.auth = { token: current };
    if (!socket.connected) {
      socket.connect();
    }
  } else if (!socket.connected && !socket.active) {
    socket.connect();
  }
  return socket;
}

/**
 * Socket connecté (ou qui le devient) : à utiliser avant d'émettre, pour ne
 * pas perdre un message quand la connexion est en cours de rétablissement.
 */
export function ensureSocket(token: string, timeoutMs = 8000): Promise<Socket> {
  const current = connectSocket(token);
  if (current.connected) {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve(current);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Connexion au serveur impossible. Vérifie ta connexion.'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      current.off('connect', onConnect);
    };
    current.once('connect', onConnect);
    if (!current.active) {
      current.connect();
    }
  });
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
  notifyConnection(false);
}

/** Socket courant (null tant qu'aucune connexion n'a été ouverte). */
export function getSocket(): Socket | null {
  return socket;
}

/**
 * État de la liaison temps réel : le listener reçoit tout de suite l'état
 * courant, puis chaque changement. C'est ce qui déclenche le rattrapage et le
 * redémarrage des envois en attente.
 */
export function onConnection(listener: (connected: boolean) => void): () => void {
  connectionListeners.add(listener);
  listener(socket?.connected ?? false);
  return () => connectionListeners.delete(listener);
}

/** Signale au serveur que ces messages sont bien arrivés sur cet appareil. */
export function reportDelivered(messageIds: string[]): void {
  if (!socket?.connected || messageIds.length === 0) return;
  socket.emit('message:ack', { messageIds });
}

/**
 * Retire un message. « Pour tous » est réservé à l'auteur et dans un délai
 * d'une journée ; « pour moi » ne change que ma propre vue. Le refus du serveur
 * remonte en exception, pour l'afficher plutôt que de laisser croire à un succès.
 */
export async function deleteMessage(
  token: string,
  conversationId: string,
  messageId: string,
  forEveryone: boolean,
): Promise<void> {
  const active = await ensureSocket(token);
  const ack = (await active
    .timeout(10_000)
    .emitWithAck('message:delete', { conversationId, messageId, forEveryone })) as
    | { error?: string }
    | undefined;
  if (ack && typeof ack.error === 'string' && ack.error) {
    throw new Error(ack.error);
  }
}
