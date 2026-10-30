import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { orderIceUrls } from './ice-servers.util.js';

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
/** Durée annoncée au client : il renouvelle sa configuration à mi-parcours. */
const CREDENTIALS_TTL_MS = 6 * 60 * 60 * 1000;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * Serveurs STUN/TURN de l'application. Les identifiants TURN vivent dans
 * l'environnement du serveur, jamais dans le bundle mobile : n'importe qui peut
 * lire un `.env` embarqué.
 */
@Controller('calls')
@UseGuards(JwtAuthGuard)
export class IceServersController {
  constructor(private readonly config: ConfigService) {}

  @Get('ice-servers')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  iceServers() {
    const stun = orderIceUrls(list(this.config.get<string>('STUN_URLS')));
    const turn = orderIceUrls(list(this.config.get<string>('TURN_URLS')));
    const username = this.config.get<string>('TURN_USERNAME');
    const credential = this.config.get<string>('TURN_CREDENTIAL');

    const servers: { urls: string; username?: string; credential?: string }[] = (
      stun.length > 0 ? stun : DEFAULT_STUN_URLS
    ).map((urls) => ({ urls }));

    if (turn.length > 0 && username && credential) {
      for (const urls of turn) {
        servers.push({ urls, username, credential });
      }
    }

    return { ttlMs: CREDENTIALS_TTL_MS, servers };
  }
}
