import { io, type Socket } from 'socket.io-client';
import { API_URL } from './config';

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
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
