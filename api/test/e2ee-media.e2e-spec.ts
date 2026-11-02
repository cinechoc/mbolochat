import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import {
  messages,
  uploadConversations,
  uploads,
} from '../src/db/schema.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { UploadsService } from '../src/uploads/uploads.service.js';
import { UploadRetentionService } from '../src/uploads/uploads-retention.service.js';

process.env.E2EE_ENABLED = 'true';

/** Fichier multipart minimal, tel que le reçoit multer. */
const asFile = (
  name: string,
  mime: string,
  body: Buffer,
): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: name,
    mimetype: mime,
    buffer: body,
    size: body.length,
  }) as Express.Multer.File;

describe('Médias chiffrés de bout en bout (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  const suffix = Date.now();
  let counter = 0;
  const written: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    db = app.get<Database>(DRIZZLE);
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    process.env.E2EE_ENABLED = 'false';
    // Les blobs de test sont posés sous uploads/ ; on les retire du disque.
    for (const relative of written) {
      await rm(join(process.cwd(), relative), { force: true });
    }
    await app.close();
  });

  const register = async (name: string) => {
    counter += 1;
    const email = `${name.toLowerCase()}_m3_${suffix}_${counter}@e2e.dev`;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Media',
        email,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    return {
      id: response.body.user.id as string,
      email,
      token: response.body.accessToken as string,
    };
  };

  const registerDevice = async (
    token: string,
    fill: number,
    prefix: string,
  ) => {
    const key = (value: number) => Buffer.alloc(32, value).toString('base64');
    const response = await request(app.getHttpServer())
      .post('/e2ee/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({
        identityKey: key(fill),
        signingKey: key(fill + 1),
        oneTimeKeys: [
          { keyId: `${prefix}-1`, key: key(fill + 2) },
          { keyId: `${prefix}-2`, key: key(fill + 3) },
        ],
      })
      .expect(201);
    return response.body as { deviceId: string };
  };

  /** Un couple en E2EE (drapeaux posés, appareils enregistrés). */
  const directPair = async (aName: string, bName: string) => {
    const alice = await register(aName);
    const bob = await register(bName);
    const conversationsService = app.get(ConversationsService);
    const conversation = await conversationsService.create(alice.id, [bob.id]);
    const aliceDevice = await registerDevice(alice.token, 40, `${aName}-dev`);
    const bobDevice = await registerDevice(bob.token, 60, `${bName}-dev`);
    return {
      alice,
      bob,
      conversation,
      aliceDevice,
      bobDevice,
      conversationsService,
    };
  };

  it('lie un fichier chiffré à la conversation et le sert à ses membres', async () => {
    const { alice, bob, conversation, aliceDevice, conversationsService } =
      await directPair('MediaAlice', 'MediaBob');
    const uploadsService = app.get(UploadsService);

    const ciphertext = Buffer.from('CIPHERTEXT-OPAQUE-CANARY-M3');
    const saved = await uploadsService.save(
      alice.id,
      asFile('photo.bin', 'application/octet-stream', ciphertext),
      { name: 'photo.jpg', width: 1600, height: 1200 },
      { encrypted: true, conversationId: conversation.id, kind: 'IMAGE' },
    );

    // Le serveur ne renvoie aucune URL signée : juste un identifiant opaque.
    expect(saved.url).toMatch(/^\/uploads\/.*\.bin$/);
    expect(saved.mime).toBe('application/octet-stream');
    written.push(saved.url.replace(/^\//, ''));

    const [row] = await db
      .select({ encrypted: uploads.encrypted, mime: uploads.mime })
      .from(uploads)
      .where(eq(uploads.id, saved.id))
      .limit(1);
    expect(row?.encrypted).toBe(true);
    expect(row?.mime).toBe('application/octet-stream');

    // Le message v1 accepte la référence chiffrée et n'expose aucune URL.
    const envelope = Buffer.from('ENV').toString('base64');
    const created = await conversationsService.createMessage(
      conversation.id,
      alice.id,
      '',
      saved.id,
      'm3-media-1',
      undefined,
      null,
      null,
      'text',
      undefined,
      'v1',
      envelope,
      aliceDevice.deviceId,
      'prekey',
    );
    expect(created.attachment).toBeNull();
    expect(created.encryptedAttachment).toEqual({ uploadId: saved.id });
    // Aucune trace du contenu clair ni du nom d'origine dans le message stocké.
    const [stored] = await db
      .select({ encryptedAttachment: messages.encryptedAttachment })
      .from(messages)
      .where(eq(messages.id, created.id))
      .limit(1);
    expect(JSON.stringify(stored?.encryptedAttachment)).not.toContain('photo');

    // Le membre télécharge le ciphertext octet pour octet.
    const download = await request(app.getHttpServer())
      .get(`/uploads/${saved.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(download.headers['content-type']).toContain(
      'application/octet-stream',
    );
    expect(download.headers['cache-control']).toContain('no-store');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(download.body).equals(ciphertext)).toBe(true);
  });

  it('refuse le téléchargement à un non-membre et masque l’existence (404)', async () => {
    const { alice, conversation } = await directPair('MediaOwner', 'MediaPeer');
    const outsider = await register('MediaOutsider');
    const uploadsService = app.get(UploadsService);

    const saved = await uploadsService.save(
      alice.id,
      asFile('secret.bin', 'application/octet-stream', Buffer.from('SECRET')),
      {},
      { encrypted: true, conversationId: conversation.id, kind: 'FILE' },
    );
    written.push(saved.url.replace(/^\//, ''));

    await request(app.getHttpServer())
      .get(`/uploads/${saved.id}`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .expect(404);

    // Un identifiant inconnu répond la même chose : rien à sonder.
    await request(app.getHttpServer())
      .get(`/uploads/${randomUUID()}`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .expect(404);

    expect(
      await uploadsService.isCiphertextReadable(saved.id, outsider.id),
    ).toBe(false);
    expect(await uploadsService.isCiphertextReadable(saved.id, alice.id)).toBe(
      true,
    );
  });

  it('refuse la lecture d’un fichier en clair par la route chiffrée', async () => {
    const alice = await register('MediaPlain');
    const uploadsService = app.get(UploadsService);
    const saved = await uploadsService.save(
      alice.id,
      asFile('note.txt', 'text/plain', Buffer.from('texte en clair')),
      {},
    );
    written.push(saved.url.replace(/^\//, ''));

    await request(app.getHttpServer())
      .get(`/uploads/${saved.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
  });

  it('refuse une pièce jointe en clair dans un message chiffré', async () => {
    const { alice, conversation, aliceDevice, conversationsService } =
      await directPair('MediaPlainRef', 'MediaPlainRefPeer');
    const uploadsService = app.get(UploadsService);
    // Import **en clair** (historique) : aucune autorisation de lecture chiffrée.
    const saved = await uploadsService.save(
      alice.id,
      asFile('photo.png', 'image/png', Buffer.from('PNG')),
      {},
    );
    written.push(saved.url.replace(/^\//, ''));

    // Le message chiffré ne doit pas pouvoir s'appuyer sur un upload clair : la
    // référence n'a pas d'autorisation de ciphertext, elle est rejetée.
    await expect(
      conversationsService.createMessage(
        conversation.id,
        alice.id,
        '',
        saved.id,
        'm3-plainref',
        undefined,
        null,
        null,
        'text',
        undefined,
        'v1',
        Buffer.from('E').toString('base64'),
        aliceDevice.deviceId,
        'prekey',
      ),
    ).rejects.toThrow(/chiffrée invalide/i);

    await request(app.getHttpServer())
      .get(`/uploads/${saved.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
  });

  it('refuse une pièce jointe chiffrée rattachée à une autre conversation', async () => {
    const { alice, conversation, aliceDevice, conversationsService } =
      await directPair('MediaCrossA', 'MediaCrossB');
    const carol = await register('MediaCrossC');
    // Deuxième conversation directe, avec un autre destinataire.
    const other = await conversationsService.create(alice.id, [carol.id]);
    const uploadsService = app.get(UploadsService);

    const saved = await uploadsService.save(
      alice.id,
      asFile('x.bin', 'application/octet-stream', Buffer.from('X')),
      {},
      { encrypted: true, conversationId: other.id, kind: 'FILE' },
    );
    written.push(saved.url.replace(/^\//, ''));

    // Le fichier appartient à `other`, pas à `conversation` : refus attendu.
    await expect(
      conversationsService.createMessage(
        conversation.id,
        alice.id,
        '',
        saved.id,
        'm3-cross',
        undefined,
        null,
        null,
        'text',
        undefined,
        'v1',
        Buffer.from('E').toString('base64'),
        aliceDevice.deviceId,
        'prekey',
      ),
    ).rejects.toThrow(/chiffrée invalide/i);
  });

  it('exclut les pièces jointes chiffrées de la galerie partagée', async () => {
    const { alice, bob, conversation, aliceDevice, conversationsService } =
      await directPair('MediaGalleryA', 'MediaGalleryB');
    const uploadsService = app.get(UploadsService);
    const saved = await uploadsService.save(
      alice.id,
      asFile('gal.bin', 'application/octet-stream', Buffer.from('G')),
      {},
      { encrypted: true, conversationId: conversation.id, kind: 'IMAGE' },
    );
    written.push(saved.url.replace(/^\//, ''));

    await conversationsService.createMessage(
      conversation.id,
      alice.id,
      '',
      saved.id,
      'm3-gallery',
      undefined,
      null,
      null,
      'text',
      undefined,
      'v1',
      Buffer.from('E').toString('base64'),
      aliceDevice.deviceId,
      'prekey',
    );

    const gallery = await conversationsService.listMedia(
      conversation.id,
      bob.id,
      50,
    );
    expect(gallery.attachments).toHaveLength(0);
  });

  it('purge les fichiers chiffrés au-delà de la rétention', async () => {
    const { alice, conversation } = await directPair(
      'MediaRetention',
      'MediaRetentionPeer',
    );
    const uploadsService = app.get(UploadsService);
    const retention = app.get(UploadRetentionService);

    const body = Buffer.from('PERIME');
    const saved = await uploadsService.save(
      alice.id,
      asFile('old.bin', 'application/octet-stream', body),
      {},
      { encrypted: true, conversationId: conversation.id, kind: 'FILE' },
    );
    const onDisk = join(process.cwd(), saved.url.replace(/^\//, ''));
    expect(onDisk).toContain('uploads');

    // Antidate la ligne : elle devient plus vieille que la fenêtre.
    await db
      .update(uploads)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(uploads.id, saved.id));

    const purged = await retention.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ id: uploads.id })
      .from(uploads)
      .where(eq(uploads.id, saved.id));
    expect(row).toBeUndefined();
    const [link] = await db
      .select({ uploadId: uploadConversations.uploadId })
      .from(uploadConversations)
      .where(eq(uploadConversations.uploadId, saved.id));
    expect(link).toBeUndefined();

    // Après purge, le téléchargement répond 404 — indiscernable d'un
    // identifiant inconnu, rien à sonder.
    await request(app.getHttpServer())
      .get(`/uploads/${saved.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
  });

  it('sert la vignette chiffrée comme blob distinct et la tient hors de la galerie', async () => {
    const { alice, bob, conversation, aliceDevice, conversationsService } =
      await directPair('MediaThumbA', 'MediaThumbB');
    const uploadsService = app.get(UploadsService);

    const video = await uploadsService.save(
      alice.id,
      asFile('video.bin', 'application/octet-stream', Buffer.from('VIDEO-CIPHER')),
      {},
      { encrypted: true, conversationId: conversation.id, kind: 'VIDEO' },
    );
    const thumb = await uploadsService.save(
      alice.id,
      asFile('thumb.bin', 'application/octet-stream', Buffer.from('THUMB-CIPHER')),
      {},
      { encrypted: true, conversationId: conversation.id, kind: 'IMAGE' },
    );
    written.push(video.url.replace(/^\//, ''), thumb.url.replace(/^\//, ''));

    // Les deux blobs se téléchargent indépendamment, octet pour octet.
    const gotVideo = await request(app.getHttpServer())
      .get(`/uploads/${video.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(Buffer.from(gotVideo.body).equals(Buffer.from('VIDEO-CIPHER'))).toBe(true);
    const gotThumb = await request(app.getHttpServer())
      .get(`/uploads/${thumb.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(Buffer.from(gotThumb.body).equals(Buffer.from('THUMB-CIPHER'))).toBe(true);

    // Référencés dans un message chiffré, ils restent exclus de la galerie.
    await conversationsService.createMessage(
      conversation.id,
      alice.id,
      '',
      video.id,
      'm3-thumb',
      undefined,
      null,
      null,
      'text',
      undefined,
      'v1',
      Buffer.from('E').toString('base64'),
      aliceDevice.deviceId,
      'prekey',
    );
    const gallery = await conversationsService.listMedia(conversation.id, bob.id, 50);
    expect(gallery.attachments).toHaveLength(0);
  });

  it('refuse l’import chiffré à un non-membre de la conversation déclarée', async () => {
    const { conversation } = await directPair('MediaImportA', 'MediaImportB');
    const outsider = await register('MediaImportOutsider');
    const uploadsService = app.get(UploadsService);

    await expect(
      uploadsService.save(
        outsider.id,
        asFile('intrus.bin', 'application/octet-stream', Buffer.from('I')),
        {},
        { encrypted: true, conversationId: conversation.id, kind: 'FILE' },
      ),
    ).rejects.toThrow(/membre/i);
  });
});
