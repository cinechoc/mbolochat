import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { ConversationsService } from './conversations.service.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';

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

  @Get(':id')
  get(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.conversationsService.getSummaryForUser(id, current.sub);
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
}
