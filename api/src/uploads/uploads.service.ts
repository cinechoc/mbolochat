import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { uploads, type MessageAttachment, type MessageAttachmentType } from '../db/schema.js';
import { detectKind, type MediaKind } from './media-kinds.js';

/** Taille maximale d'un fichier importé (15 Mo). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Ce que l'appareil joint à l'import : dimensions d'image ou durée de voix. */
export interface UploadMeta {
  width?: number;
  height?: number;
  durationMs?: number;
  mime?: string;
}

export interface UploadDto extends MessageAttachment {
  id: string;
}

@Injectable()
export class UploadsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async save(
    userId: string,
    file: Express.Multer.File | undefined,
    meta: UploadMeta = {},
  ): Promise<UploadDto> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Fichier manquant');
    }
    // Le type déclaré dans le formulaire ne sert que d'indice : c'est le nom du
    // fichier qui tranche, et le type canonique qui est retenu.
    const kind = detectKind(file.originalname, [file.mimetype, meta.mime]);
    if (!kind) {
      throw new BadRequestException('Format non pris en charge');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Fichier trop volumineux (15 Mo maximum)');
    }

    // Range les fichiers par mois : uploads/2026/10/<uuid>.m4a
    const now = new Date();
    const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const fileName = `${randomUUID()}${kind.extension}`;
    const directory = join(process.cwd(), 'uploads', folder);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), file.buffer);

    const relativeUrl = `/uploads/${folder}/${fileName}`;
    const width = kind.measures === 'image' ? this.round(meta.width) : null;
    const height = kind.measures === 'image' ? this.round(meta.height) : null;
    const durationMs = kind.measures === 'duration' ? this.round(meta.durationMs) : null;

    const [row] = await this.db
      .insert(uploads)
      .values({
        userId,
        url: relativeUrl,
        mime: kind.mime,
        size: file.size,
        width,
        height,
        durationMs,
      })
      .returning();

    return this.toDto(row.id, relativeUrl, kind, row.size, width, height, durationMs);
  }

  /** Le fichier appartient-il bien à cet utilisateur ? */
  async findOwned(id: string, userId: string): Promise<UploadDto | null> {
    const [row] = await this.db
      .select()
      .from(uploads)
      .where(eq(uploads.id, id))
      .limit(1);
    if (!row || row.userId !== userId) {
      return null;
    }
    const kind = detectKind(row.url, [row.mime]);
    return this.toDto(
      row.id,
      row.url,
      // Un fichier déjà en base garde sa nature, même si la table des formats
      // changeait entre-temps : le type stocké prime sur la déduction.
      kind ?? { extension: '', mime: row.mime, type: typeOf(row.mime), measures: 'image' },
      row.size,
      row.width,
      row.height,
      row.durationMs,
    );
  }

  private toDto(
    id: string,
    url: string,
    kind: MediaKind,
    size: number,
    width: number | null,
    height: number | null,
    durationMs: number | null,
  ): UploadDto {
    return {
      id,
      type: kind.type,
      url,
      mime: kind.mime,
      size,
      width: width ?? undefined,
      height: height ?? undefined,
      duration: durationMs ?? undefined,
    };
  }

  private round(value: number | undefined): number | null {
    return Number.isFinite(value) ? Math.round(value!) : null;
  }
}

/** La nature d'un fichier importé se lit dans son type MIME. */
function typeOf(mime: string): MessageAttachmentType {
  return mime.startsWith('audio/') ? 'AUDIO' : 'IMAGE';
}

