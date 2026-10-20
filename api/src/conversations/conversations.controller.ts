import {
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
import { UpdatePreferencesDto } from './dto/update-preferences.dto.js';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  create(@CurrentUser() current: JwtPayload, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(current.sub, dto.memberIds, dto.type, dto.name);
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

  @Get(':id')
  get(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.conversationsService.getSummaryForUser(id, current.sub);
  }

  @Patch(':id')
  rename(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Body() body: { name?: string },
  ) {
    return this.conversationsService.rename(id, current.sub, body?.name ?? '');
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

  @Get(':id/messages')
  messages(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    const beforeDate = before ? new Date(before) : undefined;
    return this.conversationsService.listMessages(id, current.sub, {
      before: beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined,
      limit,
    });
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
