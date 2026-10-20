import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { UsersService, toPublicUser } from './users.service.js';
import type { Request } from 'express';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async me(@CurrentUser() current: JwtPayload) {
    const user = await this.usersService.getByIdOrThrow(current.sub);
    return toPublicUser(user);
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() current: JwtPayload,
    @Body() body: { displayName?: string; bio?: string; notificationsEnabled?: boolean },
  ) {
    const user = await this.usersService.updateProfile(current.sub, {
      displayName: body?.displayName,
      bio: body?.bio?.trim() ? body.bio.trim() : body?.bio === '' ? null : undefined,
      notificationsEnabled: body?.notificationsEnabled,
    });
    return toPublicUser(user);
  }

  @Post('me/avatar')
  async uploadAvatar(@CurrentUser() current: JwtPayload, @Req() req: Request) {
    // Expect raw body as binary image via multipart? We'll accept base64 JSON instead.
    const body = req.body as { data?: string; mimeType?: string } | undefined;
    if (!body?.data) {
      throw new (await import('@nestjs/common')).BadRequestException('Missing image data');
    }
    const mime = body.mimeType ?? 'image/jpeg';
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const dir = join(process.cwd(), 'uploads');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = `${current.sub}.${ext}`;
    const filepath = join(dir, filename);
    const buffer = Buffer.from(body.data, 'base64');
    if (buffer.length > 2 * 1024 * 1024) {
      throw new (await import('@nestjs/common')).BadRequestException('Image too large (max 2MB)');
    }
    const stream = createWriteStream(filepath);
    stream.write(buffer);
    stream.end();
    const url = `/uploads/${filename}?v=${Date.now()}`;
    const user = await this.usersService.updateProfile(current.sub, { avatarUrl: url });
    return toPublicUser(user);
  }

  @Get('search')
  async search(@CurrentUser() current: JwtPayload, @Query('q') query?: string) {
    if (!query || query.trim().length === 0) {
      return [];
    }
    return this.usersService.search(query, current.sub);
  }

  /** Comptes bloqués par l'utilisateur courant. */
  @Get('blocked')
  async blocked(@CurrentUser() current: JwtPayload) {
    return this.usersService.listBlocked(current.sub);
  }

  @Post(':id/block')
  async block(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    await this.usersService.block(current.sub, id);
    return { blocked: true };
  }

  @Delete(':id/block')
  async unblock(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    await this.usersService.unblock(current.sub, id);
    return { blocked: false };
  }

  /**
   * Profil public d'un utilisateur (statistiques, hors données sensibles).
   * Déclaré après « search » et « blocked » pour ne pas capter ces routes.
   */
  @Get(':id')
  async profile(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.usersService.getProfile(id, current.sub);
  }
}
