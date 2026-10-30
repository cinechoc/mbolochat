import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { InvitesService } from './invites.service.js';

/**
 * Aperçu d'une invitation par son jeton : accessible sans compte, pour qu'un
 * lien partagé affiche le groupe avant même la connexion.
 */
@Controller('invites')
export class PublicInvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  preview(@Param('token') token: string) {
    return this.invitesService.preview(token);
  }

  @Post(':token/join')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  join(@CurrentUser() current: JwtPayload, @Param('token') token: string) {
    return this.invitesService.join(token, current.sub);
  }
}
