import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { ConversationsService } from './conversations.service.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import { UpdateGroupDto } from './dto/update-group.dto.js';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto.js';
import { UpdatePreferencesDto } from './dto/update-preferences.dto.js';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  create(@CurrentUser() current: JwtPayload, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(current.sub, dto.memberIds, dto.type, dto.name, {
      emoji: dto.emoji,
      color: dto.color,
      description: dto.description,
      whoCanSend: dto.whoCanSend,
      whoCanAdd: dto.whoCanAdd,
    });
  }

  @Get()
  list(@CurrentUser() current: JwtPayload) {
    return this.conversationsService.listForUser(current.sub);
  }

  /** Conversations masquées (déclaré avant « :id » pour ne pas être capté). */
  @Get('hidden')
  listHidden(@CurrentUser() current: JwtPayload) {
    return this.conversationsService.listHiddenForUser(current.sub);
  }

  /**
   * Rattrapage : tout ce qui est arrivé depuis un curseur, toutes discussions
   * confondues. C'est ce que l'app appelle après une coupure réseau.
   */
  @Get('sync')
  sync(
    @CurrentUser() current: JwtPayload,
    @Query('since') since: string,
    @Query('limit', new DefaultValuePipe(300), ParseIntPipe) limit: number,
  ) {
    const sinceDate = since ? new Date(since) : undefined;
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) {
      throw new BadRequestException('since must be an ISO timestamp');
    }
    return this.conversationsService.syncSince(current.sub, sinceDate, limit);
  }

  @Get(':id')
  get(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.conversationsService.getSummaryForUser(id, current.sub);
  }

  @Patch(':id')
  updateGroup(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.conversationsService.updateGroup(id, current.sub, {
      name: dto.name,
      description: dto.description,
      emoji: dto.emoji,
      color: dto.color,
      whoCanSend: dto.whoCanSend,
      whoCanAdd: dto.whoCanAdd,
    });
  }

  @Post(':id/photo')
  uploadPhoto(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Body() body: { data?: string; mimeType?: string },
  ) {
    if (!body?.data) {
      throw new BadRequestException('Missing image data');
    }
    return this.conversationsService.uploadPhoto(id, current.sub, body.data, body.mimeType);
  }

  @Delete(':id/photo')
  deletePhoto(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.conversationsService.deletePhoto(id, current.sub);
  }

  @Patch(':id/preferences')
  updatePreferences(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.conversationsService.setPreferences(id, current.sub, {
      pinned: dto.pinned,
      muted: dto.muted,
      hidden: dto.hidden,
    });
  }

  @Post(':id/members')
  addMembers(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Body() body: { memberIds?: string[] },
  ) {
    return this.conversationsService.addMembers(id, current.sub, body?.memberIds ?? []);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.conversationsService.removeMember(id, current.sub, userId);
  }

  @Patch(':id/members/:userId/role')
  updateMemberRole(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.conversationsService.updateMemberRole(id, current.sub, userId, dto.role);
  }

  /** Médias (pièces jointes) et liens partagés dans la conversation. */
  @Get(':id/media')
  media(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(60), ParseIntPipe) limit: number,
  ) {
    return this.conversationsService.listMedia(id, current.sub, limit);
  }

  /** Recherche simple dans l'historique de la conversation. */
  @Get(':id/search')
  search(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Query('q') query?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.conversationsService.searchMessages(id, current.sub, query ?? '', limit);
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    const beforeDate = before ? new Date(before) : undefined;
    const afterDate = after ? new Date(after) : undefined;
    return this.conversationsService.listMessages(id, current.sub, {
      before: beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined,
      after: afterDate && !Number.isNaN(afterDate.getTime()) ? afterDate : undefined,
      limit,
    });
  }

  /** Accusés de réception des messages que j'ai envoyés (coches reçue/lue). */
  @Get(':id/receipts')
  receipts(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.conversationsService.listReceipts(id, current.sub);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() current: JwtPayload) {
    await this.conversationsService.markAllRead(current.sub);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    await this.conversationsService.markRead(id, current.sub);
  }
}
