import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  conversationMembers,
  uploadConversations,
  uploads,
  type E2eeAttachmentRef,
  type MessageAttachment,
  type MessageAttachmentType,
} from '../db/schema.js';
import { detectKind, type MediaKind } from './media-kinds.js';

/** Plafond multer ; les limites par type, plus basses, sont vérifiées ensuite. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Plafond d'un fichier chiffré de bout en bout. Le ciphertext ajoute ~16 octets
 * par tranche de 256 Ko à un clair déjà borné côté appareil ; on laisse donc une
 * marge au-dessus du plafond en clair le plus haut (vidéo 40 Mo).
 */
export const MAX_ENCRYPTED_BYTES = 60 * 1024 * 1024;

const KIND_MAX_BYTES: Record<MessageAttachmentType, number> = {
  IMAGE: 25 * 1024 * 1024,
  VIDEO: 50 * 1024 * 1024,
  AUDIO: 15 * 1024 * 1024,
  FILE: 25 * 1024 * 1024,
  // Les GIF externes ne passent pas par l'import ; cette entrée garde la table
  // exhaustive vis-à-vis du type partagé.
  GIF: 15 * 1024 * 1024,
  // Un sticker est une petite image PNG/JPEG : la limite IMAGE s'applique.
  STICKER: 25 * 1024 * 1024,
};

/** Ce que l'appareil joint à l'import : dimensions, durée, nom d'origine. */
export interface UploadMeta {
  width?: number;
  height?: number;
  durationMs?: number;
  mime?: string;
  name?: string;
}

/**
 * Import chiffré de bout en bout : le fichier est opaque, seul son rattachement
 * à une conversation (métadonnée) est vérifié. Pas de type MIME déduit : tout
 * arrive en `application/octet-stream`.
 */
export interface UploadEncryptedOptions {
  encrypted: true;
  /** Conversation déclarée par l'appareil, vérifiée avant enregistrement. */
  conversationId: string;
  /** Type du clair d'origine (IMAGE, VIDEO…), pour l'affichage côté client. */
  kind: MessageAttachmentType;
}

export type UploadOptions = { encrypted?: false } | UploadEncryptedOptions;

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
    options: UploadOptions = {},
  ): Promise<UploadDto> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Fichier manquant');
    }
    return options.encrypted
      ? this.saveEncrypted(userId, file, meta, options)
      : this.savePlaintext(userId, file, meta);
  }

  /** Import historique : le serveur lit le fichier et le sert signé. */
  private async savePlaintext(
    userId: string,
    file: Express.Multer.File,
    meta: UploadMeta,
  ): Promise<UploadDto> {
    // Le type déclaré dans le formulaire ne sert que d'indice : c'est le nom du
    // fichier qui tranche, et le type canonique qui est retenu.
    const kind = detectKind(file.originalname || meta.name, [file.mimetype, meta.mime]);
    if (!kind) {
      throw new BadRequestException('Format non pris en charge');
    }
    const maxBytes = KIND_MAX_BYTES[kind.type];
    if (file.size > maxBytes) {
      throw new BadRequestException(
        `Fichier trop volumineux (${Math.round(maxBytes / (1024 * 1024))} Mo maximum)`,
      );
    }

    const relativeUrl = await this.writeFileOnDisk(file.buffer, kind.extension);
    const hasDimensions = kind.measures === 'image' || kind.measures === 'video';
    const hasDuration = kind.measures === 'duration' || kind.measures === 'video';
    const width = hasDimensions ? this.round(meta.width) : null;
    const height = hasDimensions ? this.round(meta.height) : null;
    const durationMs = hasDuration ? this.round(meta.durationMs) : null;
    const name = this.cleanName(meta.name || file.originalname, kind);

    const [row] = await this.db
      .insert(uploads)
      .values({
        userId,
        url: relativeUrl,
        mime: kind.mime,
        size: file.size,
        name,
        width,
        height,
        durationMs,
        encrypted: false,
      })
      .returning();

    return this.toDto(row.id, relativeUrl, kind, row.size, width, height, durationMs, name);
  }

  /**
   * Import chiffré : le contenu est opaque, l'appareil joint le type d'origine.
   * L'appartenance à la conversation est vérifiée ici puis journalisée : c'est
   * ce lien, et lui seul, qui autorisera le téléchargement.
   */
  private async saveEncrypted(
    userId: string,
    file: Express.Multer.File,
    meta: UploadMeta,
    options: UploadEncryptedOptions,
  ): Promise<UploadDto> {
    if (file.size > MAX_ENCRYPTED_BYTES) {
      throw new BadRequestException('Fichier chiffré trop volumineux');
    }
    if (!(await this.isMember(options.conversationId, userId))) {
      throw new ForbiddenException('Vous n’êtes pas membre de cette discussion');
    }

    const relativeUrl = await this.writeFileOnDisk(file.buffer, '.bin');
    const width = this.round(meta.width);
    const height = this.round(meta.height);
    const durationMs = this.round(meta.durationMs);
    const name = this.cleanEncryptedName(meta.name);

    const [row] = await this.db
      .insert(uploads)
      .values({
        userId,
        url: relativeUrl,
        mime: 'application/octet-stream',
        size: file.size,
        name,
        width,
        height,
        durationMs,
        encrypted: true,
      })
      .returning();

    await this.db.insert(uploadConversations).values({
      uploadId: row.id,
      conversationId: options.conversationId,
    });

    return {
      id: row.id,
      type: options.kind,
      url: relativeUrl,
      mime: 'application/octet-stream',
      size: row.size,
      width: width ?? undefined,
      height: height ?? undefined,
      duration: durationMs ?? undefined,
      name: name ?? undefined,
    };
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
      kind ?? { extension: '', mime: row.mime, type: typeOf(row.mime), measures: 'none' },
      row.size,
      row.width,
      row.height,
      row.durationMs,
      row.name,
    );
  }

  /**
   * Référence minimale d'un upload chiffré, telle qu'elle sera stockée dans le
   * message : l'identifiant, rien de plus. Le serveur ignore tout du contenu, du
   * type et de la clé — ils voyagent dans l'enveloppe chiffrée.
   */
  async encryptedRefOf(id: string): Promise<E2eeAttachmentRef | null> {
    const [row] = await this.db
      .select({ id: uploads.id })
      .from(uploads)
      .where(and(eq(uploads.id, id), eq(uploads.encrypted, true)))
      .limit(1);
    return row ? { uploadId: row.id } : null;
  }

  /**
   * Chemin relatif stocké d'un upload chiffré, ou `null` s'il n'existe pas ou
   * n'est pas chiffré. Utilisé uniquement par la route de téléchargement.
   */
  async storedPathOf(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ url: uploads.url })
      .from(uploads)
      .where(and(eq(uploads.id, id), eq(uploads.encrypted, true)))
      .limit(1);
    return row?.url ?? null;
  }

  /**
   * Un utilisateur a-t-il le droit de télécharger ce ciphertext ? Il faut que le
   * fichier soit chiffré **et** rattaché à une conversation dont il est membre.
   */
  async isCiphertextReadable(id: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ uploadId: uploadConversations.uploadId })
      .from(uploadConversations)
      .innerJoin(uploads, eq(uploads.id, uploadConversations.uploadId))
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, uploadConversations.conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .where(and(eq(uploadConversations.uploadId, id), eq(uploads.encrypted, true)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Ce ciphertext est-il rattaché **à cette** conversation, et l'appelant en
   * est-il membre ? C'est le contrôle qui empêche de réutiliser dans une
   * discussion un fichier importé pour une autre.
   */
  async isCiphertextForConversation(
    id: string,
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ uploadId: uploadConversations.uploadId })
      .from(uploadConversations)
      .innerJoin(uploads, eq(uploads.id, uploadConversations.uploadId))
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, uploadConversations.conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .where(
        and(
          eq(uploadConversations.uploadId, id),
          eq(uploadConversations.conversationId, conversationId),
          eq(uploads.encrypted, true),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Uploads chiffrés plus vieux que `before`, avec leur chemin disque. */
  async expiredEncrypted(before: Date): Promise<Array<{ id: string; url: string }>> {
    return this.db
      .select({ id: uploads.id, url: uploads.url })
      .from(uploads)
      .where(and(eq(uploads.encrypted, true), lt(uploads.createdAt, before)));
  }

  /** Supprime des lignes d'upload (le cascade nettoie le lien conversation). */
  async deleteUploads(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.db.delete(uploads).where(eq(uploads.id, id));
    }
  }

  private async isMember(conversationId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Range un fichier par mois et renvoie son chemin relatif. */
  private async writeFileOnDisk(buffer: Buffer, extension: string): Promise<string> {
    // Range les fichiers par mois : uploads/2026/10/<uuid>.m4a
    const now = new Date();
    const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const fileName = `${randomUUID()}${extension}`;
    const directory = join(process.cwd(), 'uploads', folder);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), buffer);
    return `/uploads/${folder}/${fileName}`;
  }

  private toDto(
    id: string,
    url: string,
    kind: MediaKind,
    size: number,
    width: number | null,
    height: number | null,
    durationMs: number | null,
    name: string | null,
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
      name: name ?? undefined,
    };
  }

  /**
   * Nom d'affichage d'un fichier chiffré. Le nom d'origine est une métadonnée de
   * confort ; il est nettoyé (pas de séparateur, pas de caractère de contrôle) et
   * borné. Aucune extension n'est forcée : le clair est de type inconnu ici.
   */
  private cleanEncryptedName(raw: string | undefined): string | null {
    const leaf = (raw ?? '').split(/[\\/]/).pop() ?? '';
    const base = Array.from(leaf)
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      })
      .join('')
      .trim();
    if (base && base !== '.' && base !== '..') {
      return base.slice(0, 200);
    }
    return null;
  }

  private cleanName(raw: string | undefined, kind: MediaKind): string {
    const leaf = (raw ?? '').split(/[\\/]/).pop() ?? '';
    const base = Array.from(leaf)
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      })
      .join('')
      .trim();
    if (base && base !== '.' && base !== '..') {
      return base.slice(0, 200);
    }
    switch (kind.type) {
      case 'IMAGE':
        return `photo${kind.extension}`;
      case 'VIDEO':
        return `video${kind.extension}`;
      case 'AUDIO':
        return `audio${kind.extension}`;
      default:
        return `fichier${kind.extension}`;
    }
  }

  private round(value: number | undefined): number | null {
    return Number.isFinite(value) ? Math.round(value!) : null;
  }
}

/** La nature d'un fichier importé se lit dans son type MIME. */
function typeOf(mime: string): MessageAttachmentType {
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('image/')) return 'IMAGE';
  return 'FILE';
}

