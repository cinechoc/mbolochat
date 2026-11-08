import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { UploadsService } from './uploads.service.js';

/**
 * Durée de conservation d'un fichier chiffré de bout en bout. Le serveur ne peut
 * pas savoir si un média a encore un sens ; on garde donc une fenêtre fixe,
 * généreuse mais bornée, après quoi le blob est supprimé du disque et de la base.
 * Le message chiffré, lui, reste : sa pièce jointe devient simplement illisible,
 * ce que l'app affiche comme un média expiré.
 */
const RETENTION_DAYS = 30;

/**
 * Purge périodique des fichiers chiffrés périmés. Une vérification horaire ;
 * le délai exact est appliqué par la requête (`created_at < now - rétention`).
 */
@Injectable()
export class UploadRetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly uploads: UploadsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => {
        void this.purgeExpired().catch(() => {});
      },
      60 * 60 * 1000,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Supprime les blobs chiffrés plus vieux que la fenêtre de rétention, puis les
   * réservations d'idempotence jamais abouties (processus mort avant validation).
   */
  async purgeExpired(): Promise<number> {
    const before = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const expired = await this.uploads.expiredEncrypted(before);
    if (expired.length === 0) {
      await this.uploads.purgeStaleClaims();
      return 0;
    }
    const root = resolve(process.cwd());
    for (const row of expired) {
      await this.removeStored(root, row.url);
    }
    await this.uploads.deleteUploads(expired.map((row) => row.id));
    await this.uploads.purgeStaleClaims();
    return expired.length;
  }

  /** Efface un fichier du disque en restant confiné à la racine du projet. */
  private async removeStored(root: string, stored: string): Promise<void> {
    const target = resolve(root, '.' + stored);
    if (target !== root && !target.startsWith(root + sep)) {
      return;
    }
    await rm(target, { force: true });
  }
}
