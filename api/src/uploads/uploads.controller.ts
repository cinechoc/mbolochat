import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { basename, resolve, sep } from 'node:path';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import type { MessageAttachmentType } from '../db/schema.js';
import { MAX_UPLOAD_BYTES, UploadsService } from './uploads.service.js';

/**
 * Clé d'idempotence : opaque, stable pour une même opération, et bornée. Le
 * client la dérive de l'identité durable de sa préparation média ; le serveur
 * ne l'interprète pas, il s'en sert de clé primaire `(utilisateur, clé)`.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/** Les natures qu'un appareil peut déclarer pour un fichier chiffré. */
const ENCRYPTED_KINDS = new Set<MessageAttachmentType>([
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'FILE',
  'GIF',
  'STICKER',
]);

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  /**
   * Import d'un média (multipart, champ « file »). Les dimensions de l'image et
   * la durée du vocal viennent de l'appareil : le serveur ne décode rien.
   *
   * Deux modes : en clair (historique, le serveur lit et sert signé) et chiffré
   * de bout en bout (`encrypted=1` + `conversationId` déclarée). Dans les deux
   * cas c'est le même endpoint ; le mode chiffré ne déduit ni type ni nature.
   */
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentUser() current: JwtPayload,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body()
    body: {
      width?: string;
      height?: string;
      duration?: string;
      mime?: string;
      name?: string;
      encrypted?: string;
      conversationId?: string;
      kind?: string;
    },
  ) {
    const width = UploadsController.parseNumber(body?.width, 'largeur');
    const height = UploadsController.parseNumber(body?.height, 'hauteur');
    const durationMs = UploadsController.parseNumber(body?.duration, 'durée');
    const meta = { width, height, durationMs, mime: body?.mime, name: body?.name };

    if (['1', 'true'].includes((body?.encrypted ?? '').toLowerCase())) {
      if (!body?.conversationId) {
        throw new BadRequestException('Conversation manquante pour un fichier chiffré');
      }
      const kind = (body?.kind ?? '').toUpperCase() as MessageAttachmentType;
      if (!ENCRYPTED_KINDS.has(kind)) {
        throw new BadRequestException('Nature de fichier chiffré invalide');
      }
      // Un import chiffré rejoue sans risque : la clé rend l'opération
      // idempotente, elle est donc obligatoire dans ce mode.
      if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new BadRequestException(
          'Clé d’idempotence manquante ou invalide pour un fichier chiffré',
        );
      }
      return this.uploadsService.save(current.sub, file, meta, {
        encrypted: true,
        conversationId: body.conversationId,
        kind,
        idempotencyKey,
      });
    }

    return this.uploadsService.save(current.sub, file, meta);
  }

  /**
   * Lecture d'un fichier chiffré de bout en bout. Réservé aux fichiers marqués
   * chiffrés **et** rattachés à une conversation dont l'appelant est membre :
   * l'appartenance est la seule autorisation, la signature d'URL ne s'applique
   * pas ici. Le contenu est servi tel quel, jamais interprété ni mis en cache.
   */
  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async download(
    @CurrentUser() current: JwtPayload,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.uploadsService.isCiphertextReadable(id, current.sub))) {
      // 404 et non 403 : un identifiant inconnu et un identifiant interdit sont
      // indiscernables, pour ne pas laisser sonder l'existence des fichiers.
      throw new NotFoundException('Fichier introuvable');
    }
    const stored = await this.uploadsService.storedPathOf(id);
    if (!stored) {
      throw new NotFoundException('Fichier introuvable');
    }

    const root = resolve(process.cwd());
    const target = resolve(root, '.' + stored);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new NotFoundException('Fichier introuvable');
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${basename(target)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(target, (error?: unknown) => {
      if (error) {
        res.status(404).end();
      }
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
