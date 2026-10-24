import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { MAX_UPLOAD_BYTES, UploadsService } from './uploads.service.js';

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  /**
   * Import d'un média (multipart, champ « file »). Les dimensions de l'image et
   * la durée du vocal viennent de l'appareil : le serveur ne décode rien.
   */
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentUser() current: JwtPayload,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body()
    body: { width?: string; height?: string; duration?: string; mime?: string; name?: string },
  ) {
    const width = UploadsController.parseNumber(body?.width, 'largeur');
    const height = UploadsController.parseNumber(body?.height, 'hauteur');
    const durationMs = UploadsController.parseNumber(body?.duration, 'durée');
    return this.uploadsService.save(current.sub, file, {
      width,
      height,
      durationMs,
      mime: body?.mime,
      name: body?.name,
    });
  }

  /** Un champ numérique du formulaire, vide ou invalide. */
  private static parseNumber(value: string | undefined, label: string): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new BadRequestException(`${label} invalide`);
    }
    return parsed;
  }
}
