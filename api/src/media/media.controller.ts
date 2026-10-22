import { basename, extname, resolve, sep } from 'node:path';
import { BadRequestException, Controller, Get, Query, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { kindForExtension } from '../uploads/media-kinds.js';
import { MediaService } from './media.service.js';

/** Préfixe sous lequel les fichiers sont rangés sur le disque. */
const STORAGE_PREFIX = '/uploads/';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * Lecture d'un média. Il n'y a pas de garde d'authentification ici : c'est la
   * signature qui autorise, et elle expire.
   */
  @Get()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  serve(
    @Res() res: Response,
    @Query('f') file?: string,
    @Query('e') expiresAt?: string,
    @Query('s') signature?: string,
  ): void {
    const stored = this.media.verify(
      file,
      expiresAt ? Number.parseInt(expiresAt, 10) : undefined,
      signature,
    );
    if (!stored.startsWith(STORAGE_PREFIX)) {
      throw new UnauthorizedException('Média non autorisé');
    }

    // On ne reconstruit le chemin qu'à partir du nom de fichier : « ../ » et les
    // séparateurs injectés ne peuvent pas faire sortir de la racine d'uploads.
    const relative = stored.slice(STORAGE_PREFIX.length);
    const segments = relative.split('/').filter(Boolean);
    const name = segments.pop();
    if (!name) {
      throw new BadRequestException('Chemin de média invalide');
    }
    const root = resolve(process.cwd(), 'uploads');
    const directory = resolve(root, ...segments.map((segment) => basename(segment)));
    const target = resolve(directory, basename(name));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new UnauthorizedException('Média non autorisé');
    }

    // Ce que l'import ne sait pas écrire n'a rien à être servi : une seule table.
    const type = kindForExtension(extname(target).toLowerCase())?.mime;
    if (!type) {
      throw new UnauthorizedException('Type de média non servi');
    }

    // L'URL change à chaque fenêtre : le contenu, lui, ne bouge jamais.
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(target, (error?: unknown) => {
      if (error) {
        res.status(404).end();
      }
    });
  }
}
