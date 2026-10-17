import { io, type Socket } from 'socket.io-client';
import { API_URL } from './config';

import { refreshAccessToken } from './api';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket && (socket.auth as { token?: string } | undefined)?.token === token) {
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }
  socket?.disconnect();
  socket = io(API_URL || undefined, {
    auth: { token },
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    withCredentials: true,
  });
  socket.on('connect_error', async (err: Error) => {
    if ((err as { message?: string }).message?.includes('unauthorized') || (err as { data?: { message?: string } }).data?.message?.includes('jwt')) {
      try {
        const newToken = await refreshAccessToken();
        if (socket) {
          socket.auth = { token: newToken };
          socket.connect();
        }
      } catch {
        // leave disconnected
      }
    }
  });
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
