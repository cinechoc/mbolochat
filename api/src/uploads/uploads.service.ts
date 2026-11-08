import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  conversationMembers,
  uploadConversations,
  uploadIdempotency,
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
  /**
   * Clé d'idempotence fournie par le client, stable pour toute la durée d'une
   * même opération (média principal et vignette ont chacun la leur).
   */
  idempotencyKey: string;
  /** Conversation déclarée par l'appareil, vérifiée avant enregistrement. */
  conversationId: string;
  /** Type du clair d'origine (IMAGE, VIDEO…), pour l'affichage côté client. */
  kind: MessageAttachmentType;
}

export type UploadOptions = { encrypted?: false } | UploadEncryptedOptions;

/**
 * Fenêtre pendant laquelle une seconde requête identique attend le résultat de
 * la première au lieu de créer un second blob. Au-delà, le client reçoit un
 * conflit explicite et réessaiera : rien n'est perdu, rien n'est dupliqué.
 */
const CLAIM_WAIT_MS = 4_000;
const CLAIM_POLL_MS = 100;
/**
 * Âge à partir duquel une réservation `pending` est considérée abandonnée (le
 * processus est mort avant de valider sa transaction) et peut être reprise.
 */
const CLAIM_STALE_MS = 3 * 60_000;
/** Âge au-delà duquel une réservation jamais aboutie est purement nettoyée. */
const CLAIM_EXPIRY_MS = 24 * 60 * 60_000;

/**
 * Ce que réserve une clé d'idempotence avant toute écriture.
 *
 * `token` est le jeton de **fencing** de cette tentative : il change à chaque
 * reprise. Toute validation ou tout nettoyage exige que la ligne le porte
 * encore, ce qui rend inoffensive une tentative périmée.
 */
interface KeyClaim {
  key: string;
  token: string;
  storedUrl: string;
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
   *
   * L'opération est **idempotente** : la clé du client réserve une ligne
   * `upload_idempotency` avant toute écriture, ce qui rend un rejeu après
   * timeout, coupure ou redémarrage sûr — même identifiant, même blob.
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

    const width = this.round(meta.width);
    const height = this.round(meta.height);
    const durationMs = this.round(meta.durationMs);
    const name = this.cleanEncryptedName(meta.name);
    // L'empreinte est calculée sur les octets reçus : jamais sur une valeur
    // annoncée par le client.
    const digest = createHash('sha256').update(file.buffer).digest('hex');
    const claim = await this.claimKey(userId, file, options, digest);

    if ('existing' in claim) {
      return claim.existing;
    }

    try {
      // Écriture au chemin réservé : un rejeu réécrit le même fichier, donc un
      // arrêt entre l'écriture et la validation SQL ne laisse pas d'orphelin.
      await this.storeAt(claim.storedUrl, file.buffer, claim.token);
      const row = await this.commitClaim(userId, claim, options, {
        size: file.size,
        width,
        height,
        durationMs,
        name,
      });
      return {
        id: row.id,
        type: options.kind,
        url: row.url,
        mime: 'application/octet-stream',
        size: row.size,
        width: width ?? undefined,
        height: height ?? undefined,
        duration: durationMs ?? undefined,
        name: name ?? undefined,
      };
    } catch (error) {
      // La transaction a échoué : ni ligne ni référence. On libère le blob et
      // la réservation pour qu'un rejeu immédiat soit possible.
      await this.abandonClaim(userId, claim);
      throw error;
    }
  }

  /**
   * Réserve la clé du client, ou retrouve le résultat déjà obtenu.
   *
   * L'insertion est la primitive d'atomicité : la contrainte de clé primaire
   * `(user_id, key)` garantit qu'une seule requête crée le blob, sans verrou
   * applicatif ni fenêtre de course.
   */
  private async claimKey(
    userId: string,
    file: Express.Multer.File,
    options: UploadEncryptedOptions,
    digest: string,
    depth = 0,
  ): Promise<KeyClaim | { existing: UploadDto }> {
    const storedUrl = this.allocatePath('.bin');
    const token = randomUUID();
    const inserted = await this.db
      .insert(uploadIdempotency)
      .values({
        userId,
        key: options.idempotencyKey,
        conversationId: options.conversationId,
        contentSha256: digest,
        size: file.size,
        storedUrl,
        kind: options.kind,
        attemptToken: token,
      })
      .onConflictDoNothing({
        target: [uploadIdempotency.userId, uploadIdempotency.key],
      })
      .returning({ storedUrl: uploadIdempotency.storedUrl });

    if (inserted.length > 0) {
      return { key: options.idempotencyKey, token, storedUrl };
    }
    if (depth >= 2) {
      // La réservation disparaît à répétition : on ne boucle pas, on le dit.
      throw new ConflictException('Envoi déjà en cours, réessaie dans un instant');
    }
    return this.resolveClaim(userId, file, options, digest, depth);
  }

  /** Clé déjà connue : même résultat, conflit, ou attente de la requête en cours. */
  private async resolveClaim(
    userId: string,
    file: Express.Multer.File,
    options: UploadEncryptedOptions,
    digest: string,
    depth: number,
  ): Promise<KeyClaim | { existing: UploadDto }> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      const claim = await this.loadClaim(userId, options.idempotencyKey);
      if (!claim) {
        // Réservation nettoyée entre-temps : on repart proprement.
        return this.claimKey(userId, file, options, digest, depth + 1);
      }
      // Même clé, autre contenu (ou autre conversation) : refus explicite,
      // jamais un remplacement silencieux.
      if (
        claim.conversationId !== options.conversationId ||
        claim.contentSha256 !== digest ||
        claim.size !== file.size
      ) {
        throw new ConflictException(
          'Clé d’idempotence déjà utilisée pour un autre fichier',
        );
      }
      if (claim.state === 'done' && claim.uploadId) {
        const existing = await this.uploadDtoOf(claim.uploadId, userId, claim.kind);
        // Un upload n'est annoncé réussi que si le blob est réellement là.
        if (existing && existsSync(this.absolutePath(existing.url))) {
          return { existing };
        }
        // Blob disparu (purge, perte de disque) : la réservation ne vaut plus
        // rien, on la retire pour laisser le client réenvoyer — jamais un faux
        // succès sur un fichier absent.
        await this.db
          .delete(uploadIdempotency)
          .where(
            and(
              eq(uploadIdempotency.userId, userId),
              eq(uploadIdempotency.key, options.idempotencyKey),
              eq(uploadIdempotency.state, 'done'),
              eq(uploadIdempotency.uploadId, claim.uploadId),
            ),
          );
        return this.claimKey(userId, file, options, digest, depth + 1);
      }
      // En cours ailleurs : reprendre la réservation seulement si elle est
      // abandonnée, sinon attendre brièvement son issue.
      const takeover = await this.takeOverStaleClaim(userId, options.idempotencyKey);
      if (takeover) {
        // Le chemin de l'ancienne tentative n'est plus référencé par la ligne :
        // on le libère, sans jamais toucher à celui du nouveau propriétaire.
        if (claim.storedUrl !== takeover.storedUrl) {
          await this.removeStored(claim.storedUrl);
        }
        return takeover;
      }
      if (Date.now() >= deadline) {
        throw new ConflictException('Envoi déjà en cours, réessaie dans un instant');
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
    }
  }

  /** Réponse d'un upload déjà enregistré, sans rien recréer. */
  private async uploadDtoOf(
    uploadId: string,
    userId: string,
    kind: string,
  ): Promise<UploadDto | null> {
    const [row] = await this.db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId)))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      type: kind as MessageAttachmentType,
      url: row.url,
      mime: row.mime,
      size: row.size,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      duration: row.durationMs ?? undefined,
      name: row.name ?? undefined,
    };
  }

  private async loadClaim(userId: string, key: string) {
    const [claim] = await this.db
      .select()
      .from(uploadIdempotency)
      .where(and(eq(uploadIdempotency.userId, userId), eq(uploadIdempotency.key, key)))
      .limit(1);
    return claim ?? null;
  }

  /**
   * Reprend une réservation laissée `pending` par un processus mort.
   *
   * Le `UPDATE … WHERE state = 'pending' AND updated_at < seuil` arbitre la
   * course : une seule requête gagne. Elle repart avec un **nouveau jeton** et
   * un **nouveau chemin** de fichier ; l'ancienne tentative garde le sien, donc
   * elle ne peut ni écraser le blob de la nouvelle, ni valider, ni nettoyer sa
   * réservation. Le délai n'est qu'un indice de départ, jamais une preuve.
   */
  private async takeOverStaleClaim(
    userId: string,
    key: string,
  ): Promise<KeyClaim | null> {
    const cutoff = new Date(Date.now() - CLAIM_STALE_MS);
    const token = randomUUID();
    const storedUrl = this.allocatePath('.bin');
    const taken = await this.db
      .update(uploadIdempotency)
      .set({ updatedAt: new Date(), attemptToken: token, storedUrl })
      .where(
        and(
          eq(uploadIdempotency.userId, userId),
          eq(uploadIdempotency.key, key),
          eq(uploadIdempotency.state, 'pending'),
          lt(uploadIdempotency.updatedAt, cutoff),
        ),
      )
      .returning({ attemptToken: uploadIdempotency.attemptToken });
    if (taken.length === 0) {
      return null;
    }
    return { key, token, storedUrl };
  }

  /**
   * Fichier, ligne et passage à `done` dans **une** transaction : il n'existe
   * aucun instant où le blob est annoncé sans être réellement disponible.
   */
  private async commitClaim(
    userId: string,
    claim: KeyClaim,
    options: UploadEncryptedOptions,
    meta: {
      size: number;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      name: string | null;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(uploads)
        .values({
          userId,
          url: claim.storedUrl,
          mime: 'application/octet-stream',
          size: meta.size,
          name: meta.name,
          width: meta.width,
          height: meta.height,
          durationMs: meta.durationMs,
          encrypted: true,
        })
        .returning();
      await tx.insert(uploadConversations).values({
        uploadId: row.id,
        conversationId: options.conversationId,
      });
      // La validation n'est possible que si la réservation porte encore notre
      // jeton. Sinon la transaction entière est annulée : aucune ligne d'upload
      // n'est laissée derrière une tentative périmée.
      const fenced = await tx
        .update(uploadIdempotency)
        .set({ state: 'done', uploadId: row.id, updatedAt: new Date() })
        .where(
          and(
            eq(uploadIdempotency.userId, userId),
            eq(uploadIdempotency.key, claim.key),
            eq(uploadIdempotency.state, 'pending'),
            eq(uploadIdempotency.attemptToken, claim.token),
          ),
        )
        .returning({ key: uploadIdempotency.key });
      if (fenced.length === 0) {
        throw new ConflictException(
          'Réservation reprise par une autre tentative, envoi abandonné',
        );
      }
      return row;
    });
  }

  /**
   * Libère blob et réservation après un échec de validation.
   *
   * Le fichier supprimé est celui **de cette tentative** : son chemin lui est
   * propre, une reprise en a alloué un autre. La réservation, elle, n'est
   * retirée que si elle porte encore notre jeton — une tentative périmée ne doit
   * jamais effacer le travail de la tentative qui l'a remplacée.
   */
  private async abandonClaim(userId: string, claim: KeyClaim): Promise<void> {
    await this.removeStored(claim.storedUrl);
    try {
      await this.db
        .delete(uploadIdempotency)
        .where(
          and(
            eq(uploadIdempotency.userId, userId),
            eq(uploadIdempotency.key, claim.key),
            eq(uploadIdempotency.state, 'pending'),
            eq(uploadIdempotency.attemptToken, claim.token),
          ),
        );
    } catch {
      // Réservation laissée en place : le nettoyage périodique la reprendra.
    }
  }

  /**
   * Réservations jamais abouties : le processus est mort avant de valider sa
   * transaction. Leur blob (écrit ou non) n'est référencé par aucun upload, on
   * le supprime avec la réservation ; la clé redevient libre.
   */
  async purgeStaleClaims(): Promise<number> {
    const cutoff = new Date(Date.now() - CLAIM_EXPIRY_MS);
    const stale = await this.db
      .select({
        userId: uploadIdempotency.userId,
        key: uploadIdempotency.key,
        storedUrl: uploadIdempotency.storedUrl,
        token: uploadIdempotency.attemptToken,
      })
      .from(uploadIdempotency)
      .where(
        and(
          eq(uploadIdempotency.state, 'pending'),
          lt(uploadIdempotency.updatedAt, cutoff),
        ),
      );
    for (const row of stale) {
      await this.removeStored(row.storedUrl);
      // La condition porte le jeton : si une reprise a eu lieu entre-temps, la
      // réservation rafraîchie n'est pas effacée.
      await this.db
        .delete(uploadIdempotency)
        .where(
          and(
            eq(uploadIdempotency.userId, row.userId),
            eq(uploadIdempotency.key, row.key),
            eq(uploadIdempotency.state, 'pending'),
            eq(uploadIdempotency.attemptToken, row.token),
          ),
        );
    }
    return stale.length;
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

  /** Range un fichier par mois, l'écrit et renvoie son chemin relatif. */
  private async writeFileOnDisk(buffer: Buffer, extension: string): Promise<string> {
    const relative = this.allocatePath(extension);
    await this.storeAt(relative, buffer);
    return relative;
  }

  /**
   * Réserve un chemin mensuel sans écrire : `uploads/2026/10/<uuid>.m4a`.
   * Le nom est figé avant l'écriture pour qu'une reprise réécrive le même
   * fichier au lieu d'en semer un second.
   */
  private allocatePath(extension: string): string {
    const now = new Date();
    const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `/uploads/${folder}/${randomUUID()}${extension}`;
  }

  /**
   * Écrit un fichier au chemin relatif donné, par **publication atomique**.
   *
   * Le contenu est d'abord écrit dans un temporaire propre à la tentative
   * (`.part-<jeton>`), puis renommé : aucun état partiel ne porte jamais le nom
   * définitif, et deux tentatives ne peuvent pas se mélanger dans le même
   * fichier puisqu'elles n'ont pas le même chemin.
   */
  private async storeAt(
    relative: string,
    buffer: Buffer,
    token: string = randomUUID(),
  ): Promise<void> {
    const target = this.absolutePath(relative);
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.part-${token}`;
    await writeFile(partial, buffer);
    try {
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  /**
   * Chemin absolu d'un chemin relatif de stockage, confiné au dossier
   * `uploads/` : aucun chemin venu d'ailleurs ne peut écrire hors du disque
   * prévu, y compris une valeur rejouée depuis la base.
   */
  private absolutePath(relative: string): string {
    const root = resolve(process.cwd(), 'uploads');
    const target = resolve(process.cwd(), '.' + relative);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new BadRequestException('Chemin de fichier invalide');
    }
    return target;
  }

  private async removeStored(relative: string): Promise<void> {
    try {
      await rm(this.absolutePath(relative), { force: true });
    } catch {
      // Disque indisponible ou chemin refusé : rien à faire de plus.
    }
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

