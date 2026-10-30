import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import { ResolveJoinRequestDto } from './dto/resolve-join-request.dto.js';
import { InvitesService } from './invites.service.js';

/** Gestion des invitations d'un groupe : réservée aux membres connectés. */
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post(':id/invites')
  create(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invitesService.create(id, current.sub, {
      expiresInHours: dto.expiresInHours,
      maxUses: dto.maxUses,
      requiresApproval: dto.requiresApproval,
    });
  }

  @Get(':id/invites')
  list(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.invitesService.list(id, current.sub);
  }

  @Delete(':id/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    await this.invitesService.revoke(id, inviteId, current.sub);
  }

  @Get(':id/join-requests')
  listJoinRequests(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.invitesService.listJoinRequests(id, current.sub);
  }

  @Post(':id/join-requests/:requestId/resolve')
  resolveJoinRequest(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: ResolveJoinRequestDto,
  ) {
    return this.invitesService.resolveJoinRequest(id, current.sub, requestId, dto.action);
  }
}
