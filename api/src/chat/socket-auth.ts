import type { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import type { JwtPayload } from '../auth/jwt-payload.js';

export const userRoomOf = (userId: string) => `user:${userId}`;

/**
 * Authentifie le handshake Socket.IO (JWT d'accès) et joint le salon personnel
 * de l'utilisateur. Partagé par les gateways chat et appels : un socket non
 * authentifié est déconnecté.
 */
export async function authenticateSocket(client: Socket, jwtService: JwtService): Promise<void> {
  const token = (client.handshake.auth as { token?: string } | undefined)?.token;
  try {
    const payload = await jwtService.verifyAsync<JwtPayload>(token ?? '');
    if (payload.type !== 'access') {
      throw new Error('invalid token type');
    }
    client.data.userId = payload.sub;
    await client.join(userRoomOf(payload.sub));
  } catch {
    client.disconnect(true);
  }
}
