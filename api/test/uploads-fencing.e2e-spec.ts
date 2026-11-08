import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { uploadConversations, uploadIdempotency, uploads } from '../src/db/schema.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { UploadsService, type UploadDto } from '../src/uploads/uploads.service.js';

process.env.E2EE_ENABLED = 'true';

/** Fichier multipart minimal, tel que le reçoit multer. */
const asFile = (body: Buffer): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'photo.bin',
    mimetype: 'application/octet-stream',
    buffer: body,
    size: body.length,
  }) as Express.Multer.File;

/** Réservation telle que la manipule le service. */
interface KeyClaim {
  key: string;
  token: string;
  storedUrl: string;
}

interface Internals {
  claimKey(
    userId: string,
    file: Express.Multer.File,
    options: unknown,
    digest: string,
    depth?: number,
  ): Promise<KeyClaim | { existing: UploadDto }>;
  resolveClaim(
    userId: string,
    file: Express.Multer.File,
    options: unknown,
    digest: string,
    depth: number,
  ): Promise<KeyClaim | { existing: UploadDto }>;
  commitClaim(
    userId: string,
    claim: KeyClaim,
    options: unknown,
    meta: {
      size: number;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      name: string | null;
    },
  ): Promise<{ id: string; url: string }>;
  abandonClaim(userId: string, claim: KeyClaim): Promise<void>;
  storeAt(relative: string, buffer: Buffer, token?: string): Promise<void>;
}

/**
 * Propriété des réservations d'idempotence (étape 1.2d, audit correctif).
 *
 * Les deux tentatives sont réellement intercalées : on pilote les étapes
 * internes du service (`claimKey` → `resolveClaim` → `storeAt` →
 * `commitClaim` / `abandonClaim`) sur la **vraie** base PostgreSQL et le **vrai**
 * disque. Aucune simulation de la course, aucun mock de stockage.
 */
describe('Fencing des réservations d’upload (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let service: UploadsService;
  let internals: Internals;
  const suffix = Date.now();
  let counter = 0;
  const createdUsers: string[] = [];
  const written: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get<Database>(DRIZZLE);
    service = app.get(UploadsService);
    internals = service as unknown as Internals;
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    for (const relative of written) {
      await rm(join(process.cwd(), relative), { force: true });
    }
    for (const userId of createdUsers) {
      await db.delete(uploadIdempotency).where(eq(uploadIdempotency.userId, userId));
    }
    process.env.E2EE_ENABLED = 'false';
    await app.close();
  });

  const register = async (name: string) => {
    counter += 1;
    const email = `${name.toLowerCase()}_fence_${suffix}_${counter}@e2e.dev`;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Fence',
        email,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id, token: response.body.accessToken as string };
  };

  /** Un compte et une conversation directe (contexte autorisé). */
  const context = async (name: string) => {
    const owner = await register(name);
    const peer = await register(`${name}Peer`);
    const conversation = await app.get(ConversationsService).create(owner.id, [peer.id]);
    const options = {
      encrypted: true as const,
      conversationId: conversation.id,
      kind: 'IMAGE' as const,
      idempotencyKey: `${randomUUID()}:media`,
    };
    return { owner, peer, conversation, options };
  };

  const digestOf = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

  const age = async (userId: string, key: string, minutes: number) => {
    await db
      .update(uploadIdempotency)
      .set({ updatedAt: new Date(Date.now() - minutes * 60_000) })
      .where(
        and(eq(uploadIdempotency.userId, userId), eq(uploadIdempotency.key, key)),
      );
  };

  const claimRow = async (userId: string, key: string) => {
    const [row] = await db
      .select()
      .from(uploadIdempotency)
      .where(
        and(eq(uploadIdempotency.userId, userId), eq(uploadIdempotency.key, key)),
      );
    return row;
  };

  const rowsOf = async (userId: string) =>
    db.select().from(uploads).where(eq(uploads.userId, userId));

  const onDisk = (storedUrl: string) => join(process.cwd(), storedUrl.replace(/^\//, ''));

  const meta = (buffer: Buffer) => ({
    size: buffer.length,
    width: null,
    height: null,
    durationMs: null,
    name: 'photo.jpg',
  });

  it('une tentative périmée ne peut ni valider, ni nettoyer après une reprise', async () => {
    const { owner, options } = await context('FenceStale');
    const content = Buffer.from('CIPHERTEXT-FENCED');
    const file = asFile(content);

    // 1. A réserve la clé.
    const a = (await internals.claimKey(owner.id, file, options, digestOf(content))) as KeyClaim;
    expect(a.token).toBeTruthy();

    // A écrit son fichier (écriture « lente » terminée) puis se fige.
    await internals.storeAt(a.storedUrl, content, a.token);
    written.push(a.storedUrl.replace(/^\//, ''));
    expect(existsSync(onDisk(a.storedUrl))).toBe(true);

    // 2. Le délai expire : B reprend la réservation.
    await age(owner.id, options.idempotencyKey, 10);
    const b = (await internals.resolveClaim(
      owner.id,
      file,
      options,
      digestOf(content),
      0,
    )) as KeyClaim;
    expect(b.token).not.toBe(a.token);
    expect(b.storedUrl).not.toBe(a.storedUrl);

    const afterTakeover = await claimRow(owner.id, options.idempotencyKey);
    expect(afterTakeover!.attemptToken).toBe(b.token);
    expect(afterTakeover!.storedUrl).toBe(b.storedUrl);
    // Le chemin de A n'est plus référencé : la reprise l'a libéré.
    expect(existsSync(onDisk(a.storedUrl))).toBe(false);

    // B écrit son propre fichier.
    await internals.storeAt(b.storedUrl, content, b.token);
    written.push(b.storedUrl.replace(/^\//, ''));

    // 3. A échoue maintenant et tente de nettoyer.
    await internals.abandonClaim(owner.id, a);

    // 4. Le nettoyage de A ne touche ni la réservation ni le fichier de B.
    const stillB = await claimRow(owner.id, options.idempotencyKey);
    expect(stillB).toBeDefined();
    expect(stillB!.state).toBe('pending');
    expect(stillB!.attemptToken).toBe(b.token);
    expect(existsSync(onDisk(b.storedUrl))).toBe(true);

    // 5. B termine et valide correctement.
    const row = await internals.commitClaim(owner.id, b, options, meta(content));
    const finalClaim = await claimRow(owner.id, options.idempotencyKey);
    expect(finalClaim!.state).toBe('done');
    expect(finalClaim!.uploadId).toBe(row.id);
    expect(existsSync(onDisk(b.storedUrl))).toBe(true);
    expect(readFileSync(onDisk(b.storedUrl)).equals(content)).toBe(true);
    expect(await rowsOf(owner.id)).toHaveLength(1);

    // 6. A essaie de valider après avoir perdu la propriété : rejet, rien de créé.
    await expect(
      internals.commitClaim(owner.id, a, options, meta(content)),
    ).rejects.toThrow(/reprise/i);
    expect(await rowsOf(owner.id)).toHaveLength(1);
    const links = await db
      .select()
      .from(uploadConversations)
      .where(eq(uploadConversations.uploadId, row.id));
    expect(links).toHaveLength(1);
  });

  it('deux reprises successives : seule la dernière tentative peut valider', async () => {
    const { owner, options } = await context('FenceTwice');
    const content = Buffer.from('CIPHERTEXT-TWICE');
    const file = asFile(content);

    const a = (await internals.claimKey(owner.id, file, options, digestOf(content))) as KeyClaim;
    await age(owner.id, options.idempotencyKey, 10);
    const b = (await internals.resolveClaim(
      owner.id,
      file,
      options,
      digestOf(content),
      0,
    )) as KeyClaim;
    await age(owner.id, options.idempotencyKey, 10);
    const c = (await internals.resolveClaim(
      owner.id,
      file,
      options,
      digestOf(content),
      0,
    )) as KeyClaim;

    // Trois tentatives, trois jetons, trois chemins distincts.
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
    expect(new Set([a.storedUrl, b.storedUrl, c.storedUrl]).size).toBe(3);

    await internals.storeAt(a.storedUrl, content, a.token);
    await internals.storeAt(b.storedUrl, content, b.token);
    await internals.storeAt(c.storedUrl, content, c.token);
    for (const claim of [a, b, c]) written.push(claim.storedUrl.replace(/^\//, ''));

    // B, pourtant plus récente que A, a déjà perdu la propriété.
    await expect(
      internals.commitClaim(owner.id, b, options, meta(content)),
    ).rejects.toThrow(/reprise/i);
    await expect(
      internals.commitClaim(owner.id, a, options, meta(content)),
    ).rejects.toThrow(/reprise/i);
    expect(await rowsOf(owner.id)).toHaveLength(0);

    const row = await internals.commitClaim(owner.id, c, options, meta(content));
    expect(await rowsOf(owner.id)).toHaveLength(1);
    const finalClaim = await claimRow(owner.id, options.idempotencyKey);
    expect(finalClaim!.attemptToken).toBe(c.token);
    expect(finalClaim!.uploadId).toBe(row.id);
  });

  it('une réservation vivante n’est pas reprise par une tentative concurrente', async () => {
    const { owner, options } = await context('FenceLive');
    const content = Buffer.from('CIPHERTEXT-LIVE');
    const file = asFile(content);

    const a = (await internals.claimKey(owner.id, file, options, digestOf(content))) as KeyClaim;
    // Réservation fraîche : pas de reprise possible, la seconde requête attend
    // puis reçoit un conflit explicite (rien n'est écrit).
    await expect(
      internals.resolveClaim(owner.id, file, options, digestOf(content), 0),
    ).rejects.toThrow(/en cours/i);

    const claim = await claimRow(owner.id, options.idempotencyKey);
    expect(claim!.attemptToken).toBe(a.token);
    expect(claim!.state).toBe('pending');
  });

  it('aucun fichier partiel ne porte jamais le nom définitif', async () => {
    const { owner, options } = await context('FencePartial');
    const content = Buffer.from('CIPHERTEXT-PARTIAL');
    const file = asFile(content);
    const a = (await internals.claimKey(owner.id, file, options, digestOf(content))) as KeyClaim;
    written.push(a.storedUrl.replace(/^\//, ''));

    // Une écriture qui échoue ne publie rien sous le nom définitif.
    await expect(
      internals.storeAt(a.storedUrl, content, `${a.token}-bis`),
    ).resolves.toBeUndefined();
    expect(existsSync(onDisk(a.storedUrl))).toBe(true);
    // Le temporaire de la tentative a bien disparu après publication.
    const directory = onDisk(a.storedUrl).slice(0, onDisk(a.storedUrl).lastIndexOf('/'));
    const leftovers = (await import('node:fs')).readdirSync(directory).filter((name) =>
      name.includes(a.storedUrl.split('/').pop()!),
    );
    expect(leftovers).toEqual([a.storedUrl.split('/').pop()]);
  });
});
