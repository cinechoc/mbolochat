import {
  Body,
  BadRequestException,
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
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
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
    @Body()
    body: {
      displayName?: string;
      bio?: string;
      notificationsEnabled?: boolean;
      notificationSound?: boolean;
      notificationPreview?: boolean;
    },
  ) {
    const user = await this.usersService.updateProfile(current.sub, {
      displayName: body?.displayName,
      bio: body?.bio?.trim() ? body.bio.trim() : body?.bio === '' ? null : undefined,
      notificationsEnabled: body?.notificationsEnabled,
      notificationSound: body?.notificationSound,
      notificationPreview: body?.notificationPreview,
    });
    return toPublicUser(user);
  }

  @Post('me/avatar')
  async uploadAvatar(@CurrentUser() current: JwtPayload, @Req() req: Request) {    // Expect raw body as binary image via multipart? We'll accept base64 JSON instead.
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
    // Un changement d'extension laisserait l'ancien fichier orphelin et servi.
    for (const oldExt of ['png', 'jpg', 'webp']) {
      if (oldExt !== ext) rmSync(join(dir, `${current.sub}.${oldExt}`), { force: true });
    }
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

  /** Retire la photo de profil et efface les fichiers d'avatar de ce compte. */
  @Delete('me/avatar')
  async deleteAvatar(@CurrentUser() current: JwtPayload) {
    const dir = join(process.cwd(), 'uploads');
    // Les anciens uploads pouvaient avoir une autre extension (png/jpg/webp).
    for (const ext of ['png', 'jpg', 'webp']) {
      rmSync(join(dir, `${current.sub}.${ext}`), { force: true });
    }
    const user = await this.usersService.updateProfile(current.sub, { avatarUrl: null });
    return toPublicUser(user);
  }

  /** Enregistre le jeton push de l'appareil pour les notifications. */
  @Post('me/push-token')
  async registerPushToken(
    @CurrentUser() current: JwtPayload,
    @Body() body: { token?: string; platform?: string; apiBaseUrl?: string },
  ) {
    const token = body?.token?.trim();
    if (!token) {
      throw new BadRequestException('Missing push token');
    }
    await this.usersService.registerPushToken(
      current.sub,
      token,
      body?.platform ?? 'android',
      body?.apiBaseUrl,
    );
    return { registered: true };
  }

  @Delete('me/push-token')
  async removePushToken(@CurrentUser() current: JwtPayload, @Body() body: { token?: string }) {
    const token = body?.token?.trim();
    if (token) {
      await this.usersService.removePushToken(current.sub, token);
    }
    return { registered: false };
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
