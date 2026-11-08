import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { uploadConversations, uploadIdempotency, uploads } from '../src/db/schema.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { UploadsService } from '../src/uploads/uploads.service.js';

process.env.E2EE_ENABLED = 'true';

/**
 * Idempotence de `POST /uploads` (étape 1.2d).
 *
 * Tous les cas passent par la vraie route HTTP, la vraie base PostgreSQL et le
 * vrai disque (`uploads/`) : seul l'état intermédiaire d'une coupure est
 * reconstruit à la main, faute de pouvoir tuer le processus au bon instant.
 */
describe('Idempotence des téléversements chiffrés (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  const suffix = Date.now();
  let counter = 0;
  /** Chemins relatifs écrits par les tests, retirés du disque à la fin. */
  const written: string[] = [];
  /** Utilisateurs créés, pour nettoyer leurs réservations. */
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get<Database>(DRIZZLE);
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
    const email = `${name.toLowerCase()}_m4_${suffix}_${counter}@e2e.dev`;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Idem',
        email,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id, email, token: response.body.accessToken as string };
  };

  /** Un couple avec une conversation directe (contexte autorisé). */
  const pair = async (aName: string, bName: string) => {
    const alice = await register(aName);
    const bob = await register(bName);
    const conversation = await app.get(ConversationsService).create(alice.id, [bob.id]);
    return { alice, bob, conversation };
  };

  /** `POST /uploads` chiffré, avec clé d'idempotence. Chaînable (`.expect`). */
  const upload = (options: {
    token: string;
    key?: string;
    conversationId: string;
    content: Buffer;
    kind?: string;
    name?: string;
  }) => {
    const agent = request(app.getHttpServer())
      .post('/uploads')
      .set('Authorization', `Bearer ${options.token}`);
    if (options.key !== undefined) {
      agent.set('Idempotency-Key', options.key);
    }
    return agent
      .field('encrypted', '1')
      .field('conversationId', options.conversationId)
      .field('kind', options.kind ?? 'IMAGE')
      .field('name', options.name ?? 'photo.jpg')
      .attach('file', options.content, {
        filename: 'photo.bin',
        contentType: 'application/octet-stream',
      });
  };

  const claimsOf = async (userId: string, key: string) => {
    return db
      .select()
      .from(uploadIdempotency)
      .where(and(eq(uploadIdempotency.userId, userId), eq(uploadIdempotency.key, key)));
  };

  /** Chemin réellement stocké pour une clé (la réponse HTTP, elle, est signée). */
  const storedOf = async (userId: string, key: string) => {
    const [claim] = await claimsOf(userId, key);
    return claim.storedUrl;
  };

  const uploadsOf = async (userId: string) => {
    return db.select().from(uploads).where(eq(uploads.userId, userId));
  };

  /** Chemin absolu sur disque d'un chemin de stockage relatif. */
  const onDisk = (storedUrl: string) => join(process.cwd(), storedUrl.replace(/^\//, ''));

  /**
   * Date de dernière écriture du blob. Un rejeu ne doit **pas** réécrire le
   * fichier : c'est la preuve qu'aucun second blob n'a été créé ni écrasé.
   */
  const mtimeOf = (storedUrl: string) => statSync(onDisk(storedUrl)).mtimeMs;

  it('1. un premier envoi crée le blob, la ligne et la réservation', async () => {
    const { alice, conversation } = await pair('IdemFirst', 'IdemPeer');
    const content = Buffer.from('CIPHERTEXT-FIRST');
    const key = `${randomUUID()}:media`;

    const response = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    const id = response.body.id as string;
    expect(id).toBeTruthy();
    expect(response.body.type).toBe('IMAGE');
    expect(response.body.mime).toBe('application/octet-stream');
    expect(response.body.name).toBe('photo.jpg');

    const rows = await uploadsOf(alice.id);
    written.push(rows[0].url.replace(/^\//, ''));
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(content.length);
    expect(rows[0].encrypted).toBe(true);
    // Le lien de conversation est journalisé : c'est lui qui autorise la lecture.
    const link = await db
      .select()
      .from(uploadConversations)
      .where(eq(uploadConversations.uploadId, id));
    expect(link).toHaveLength(1);
    expect(link[0].conversationId).toBe(conversation.id);

    // L'empreinte stockée est celle des octets reçus, calculée par le serveur.
    const [claim] = await claimsOf(alice.id, key);
    expect(claim.state).toBe('done');
    expect(claim.uploadId).toBe(id);
    expect(claim.contentSha256).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    expect(claim.conversationId).toBe(conversation.id);
    // Le fichier est réellement sur le disque, avec les octets attendus.
    expect(readFileSync(join(process.cwd(), rows[0].url.slice(1))).equals(content)).toBe(true);
    // L'URL renvoyée est signée (et encodée), mais pointe le même fichier.
    expect(decodeURIComponent(response.body.url)).toContain(rows[0].url);
  });

  it('2. un second envoi identique rend le même identifiant, sans nouveau blob', async () => {
    const { alice, conversation } = await pair('IdemRepeat', 'IdemPeer');
    const content = Buffer.from('CIPHERTEXT-REPEAT');
    const key = `${randomUUID()}:media`;

    const first = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);
    const stored = await storedOf(alice.id, key);
    written.push(stored.replace(/^\//, ''));
    const writtenAt = mtimeOf(stored);

    const second = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    // Même identifiant, même chemin, mêmes métadonnées ; l'URL signée est
    // recalculée à chaque réponse, elle n'est pas comparable telle quelle.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({
      type: first.body.type,
      mime: first.body.mime,
      size: first.body.size,
      name: first.body.name,
    });
    expect(await storedOf(alice.id, key)).toBe(stored);
    expect(await uploadsOf(alice.id)).toHaveLength(1);
    // Le blob n'a pas été réécrit une seconde fois.
    expect(mtimeOf(stored)).toBe(writtenAt);
  });

  it('3. même clé, autre contenu : conflit explicite, rien n’est remplacé', async () => {
    const { alice, conversation } = await pair('IdemConflict', 'IdemPeer');
    const key = `${randomUUID()}:media`;
    const original = Buffer.from('CIPHERTEXT-ORIGINAL');

    await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content: original,
    }).expect(201);
    const stored = await storedOf(alice.id, key);
    written.push(stored.replace(/^\//, ''));

    const conflict = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-DIFFERENT'),
    }).expect(409);
    expect(String(conflict.body.message)).toContain('idempotence');

    // Le blob d'origine et son empreinte sont intacts.
    expect(readFileSync(join(process.cwd(), stored.slice(1))).equals(original)).toBe(true);
    const [claim] = await claimsOf(alice.id, key);
    expect(claim.contentSha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    expect(await uploadsOf(alice.id)).toHaveLength(1);
  });

  it('3 bis. une clé ne peut pas changer de conversation', async () => {
    const alice = await register('IdemContext');
    const peer = await register('IdemContextPeer');
    const other = await register('IdemContextOther');
    const service = app.get(ConversationsService);
    const conversation = await service.create(alice.id, [peer.id]);
    const elsewhere = await service.create(alice.id, [other.id]);
    const key = `${randomUUID()}:media`;

    await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-CONTEXT'),
    }).expect(201);
    written.push((await storedOf(alice.id, key)).replace(/^\//, ''));

    await upload({
      token: alice.token,
      key,
      conversationId: elsewhere.id,
      content: Buffer.from('CIPHERTEXT-CONTEXT'),
    }).expect(409);
  });

  it('4. deux requêtes simultanées identiques ne créent qu’un blob', async () => {
    const { alice, conversation } = await pair('IdemRace', 'IdemPeer');
    const content = Buffer.from('CIPHERTEXT-RACE');
    const key = `${randomUUID()}:media`;

    const [a, b] = await Promise.all([
      upload({ token: alice.token, key, conversationId: conversation.id, content }),
      upload({ token: alice.token, key, conversationId: conversation.id, content }),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    written.push((await storedOf(alice.id, key)).replace(/^\//, ''));
    expect(await uploadsOf(alice.id)).toHaveLength(1);
    // Une seule ligne `done`, une seule réservation.
    const claims = await claimsOf(alice.id, key);
    expect(claims).toHaveLength(1);
    expect(claims[0].state).toBe('done');
  });

  it('5. réponse perdue puis rejeu : même identifiant, même ligne, aucun octet de plus', async () => {
    const { alice, conversation } = await pair('IdemLost', 'IdemPeer');
    const content = Buffer.from('CIPHERTEXT-LOST-RESPONSE');
    const key = `${randomUUID()}:media`;

    const first = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);
    const stored = await storedOf(alice.id, key);
    written.push(stored.replace(/^\//, ''));
    const [before] = await uploadsOf(alice.id);
    const writtenAt = mtimeOf(stored);

    // Le client n'a jamais lu cette réponse : il rejoue la même requête.
    const retry = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    const [after] = await uploadsOf(alice.id);
    expect(retry.body.id).toBe(first.body.id);
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(await storedOf(alice.id, key)).toBe(stored);
    expect(mtimeOf(stored)).toBe(writtenAt);
  });

  it('6. une requête invalide ou interrompue ne réserve rien', async () => {
    const { alice, bob, conversation } = await pair('IdemAbort', 'IdemPeer');
    const key = `${randomUUID()}:media`;

    // Corps invalide (nature inconnue) : refusé avant toute réservation.
    await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-INVALID'),
      kind: 'NOT_A_KIND',
    }).expect(400);
    expect(await claimsOf(alice.id, key)).toHaveLength(0);

    // Non-membre : refusé avant toute réservation également.
    const outsiderKey = `${randomUUID()}:media`;
    await upload({
      token: bob.token,
      key: outsiderKey,
      conversationId: randomUUID(),
      content: Buffer.from('CIPHERTEXT-OUTSIDER'),
    }).expect(403);
    expect(await claimsOf(bob.id, outsiderKey)).toHaveLength(0);

    // Fichier absent : même chose, aucune réservation ni ligne.
    const noFileKey = `${randomUUID()}:media`;
    await request(app.getHttpServer())
      .post('/uploads')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('Idempotency-Key', noFileKey)
      .field('encrypted', '1')
      .field('conversationId', conversation.id)
      .field('kind', 'IMAGE')
      .expect(400);
    expect(await claimsOf(alice.id, noFileKey)).toHaveLength(0);
    expect(await uploadsOf(alice.id)).toHaveLength(0);
  });

  it('7. écriture disque sans validation SQL : la reprise libère l’ancien fichier', async () => {
    const { alice, conversation } = await pair('IdemHalfway', 'IdemPeer');
    const content = Buffer.from('CIPHERTEXT-HALFWAY');
    const key = `${randomUUID()}:media`;

    // État exact d'un processus mort entre l'écriture du fichier et la
    // transaction : réservation `pending` avec son chemin, blob déjà écrit.
    const folder = `${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const storedUrl = `/uploads/${folder}/${randomUUID()}.bin`;
    await mkdir(join(process.cwd(), 'uploads', folder), { recursive: true });
    await writeFile(join(process.cwd(), storedUrl.slice(1)), content);
    written.push(storedUrl.slice(1));
    await db.insert(uploadIdempotency).values({
      userId: alice.id,
      key,
      conversationId: conversation.id,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      storedUrl,
      kind: 'IMAGE',
      attemptToken: randomUUID(),
      state: 'pending',
      // Réservation périmée : le processus est mort il y a dix minutes.
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    const response = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    // La reprise ouvre sa **propre** tentative : nouveau jeton, nouveau chemin.
    // L'ancien fichier n'est plus référencé, il est libéré.
    const current = await storedOf(alice.id, key);
    expect(current).not.toBe(storedUrl);
    expect(decodeURIComponent(response.body.url)).toContain(current);
    expect(existsSync(onDisk(storedUrl))).toBe(false);
    expect(await uploadsOf(alice.id)).toHaveLength(1);
    expect(readFileSync(onDisk(current)).equals(content)).toBe(true);
    const [claim] = await claimsOf(alice.id, key);
    expect(claim.state).toBe('done');
    expect(claim.uploadId).toBe(response.body.id);
    expect(claim.storedUrl).toBe(current);
  });

  it('7 bis. une réservation en cours refuse un contenu différent', async () => {
    const { alice, conversation } = await pair('IdemPending', 'IdemPeer');
    const key = `${randomUUID()}:media`;
    const folder = `${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const storedUrl = `/uploads/${folder}/${randomUUID()}.bin`;
    await db.insert(uploadIdempotency).values({
      userId: alice.id,
      key,
      conversationId: conversation.id,
      contentSha256: createHash('sha256').update(Buffer.from('AUTRE')).digest('hex'),
      size: 5,
      storedUrl,
      kind: 'IMAGE',
      attemptToken: randomUUID(),
      state: 'pending',
      updatedAt: new Date(),
    });

    await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content: Buffer.from('CONTENU-DIFFERENT'),
    }).expect(409);
    // Rien n'a été écrit ni repris.
    expect(existsSync(join(process.cwd(), storedUrl.slice(1)))).toBe(false);
    expect(await uploadsOf(alice.id)).toHaveLength(0);
  });

  it('8. deux comptes avec la même clé ne se rencontrent pas', async () => {
    const { alice, bob, conversation } = await pair('IdemOwner', 'IdemOther');
    const key = 'cle-partagee-volontairement:media';
    const aliceContent = Buffer.from('CIPHERTEXT-ALICE');
    const bobContent = Buffer.from('CIPHERTEXT-BOB');

    const first = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content: aliceContent,
    }).expect(201);
    const aliceStored = await storedOf(alice.id, key);
    written.push(aliceStored.replace(/^\//, ''));

    const second = await upload({
      token: bob.token,
      key,
      conversationId: conversation.id,
      content: bobContent,
    }).expect(201);
    const bobStored = await storedOf(bob.id, key);
    written.push(bobStored.replace(/^\//, ''));

    // Clés identiques, propriétaires différents : deux blobs distincts.
    expect(second.body.id).not.toBe(first.body.id);
    expect(aliceStored).not.toBe(bobStored);
    expect(readFileSync(join(process.cwd(), aliceStored.slice(1))).equals(aliceContent)).toBe(
      true,
    );
    expect(readFileSync(join(process.cwd(), bobStored.slice(1))).equals(bobContent)).toBe(true);
    const [aliceClaim] = await claimsOf(alice.id, key);
    const [bobClaim] = await claimsOf(bob.id, key);
    expect(aliceClaim.uploadId).toBe(first.body.id);
    expect(bobClaim.uploadId).toBe(second.body.id);

    // Et un tiers ne peut pas lire le ciphertext de l'autre via sa clé.
    const [shared] = await db
      .select()
      .from(uploadConversations)
      .where(eq(uploadConversations.uploadId, second.body.id));
    const third = await register('IdemThird');
    await request(app.getHttpServer())
      .get(`/uploads/${second.body.id}`)
      .set('Authorization', `Bearer ${third.token}`)
      .expect(404);
    expect(shared?.conversationId).toBe(conversation.id);
  });

  it('9. média et vignette ont chacun leur clé', async () => {
    const { alice, conversation } = await pair('IdemThumb', 'IdemPeer');
    const clientId = randomUUID();

    const media = await upload({
      token: alice.token,
      key: `${clientId}:media`,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-MEDIA'),
      kind: 'IMAGE',
    }).expect(201);
    written.push((await storedOf(alice.id, `${clientId}:media`)).replace(/^\//, ''));
    const thumb = await upload({
      token: alice.token,
      key: `${clientId}:thumb`,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-THUMB'),
      kind: 'IMAGE',
    }).expect(201);
    written.push((await storedOf(alice.id, `${clientId}:thumb`)).replace(/^\//, ''));

    expect(thumb.body.id).not.toBe(media.body.id);
    expect(await uploadsOf(alice.id)).toHaveLength(2);
    // Rejouer la vignette seule ne touche pas au média.
    const again = await upload({
      token: alice.token,
      key: `${clientId}:thumb`,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-THUMB'),
      kind: 'IMAGE',
    }).expect(201);
    expect(again.body.id).toBe(thumb.body.id);
    expect(await uploadsOf(alice.id)).toHaveLength(2);
  });

  it('10. régression : l’import en clair reste inchangé et sans clé', async () => {
    const alice = await register('IdemPlain');
    const response = await request(app.getHttpServer())
      .post('/uploads')
      .set('Authorization', `Bearer ${alice.token}`)
      .field('name', 'note.png')
      .attach('file', Buffer.from('PNG-PLAIN'), {
        filename: 'note.png',
        contentType: 'image/png',
      })
      .expect(201);

    expect(response.body.type).toBe('IMAGE');
    expect(response.body.mime).toBe('image/png');
    const [row] = await uploadsOf(alice.id);
    written.push(row.url.replace(/^\//, ''));
    expect(row.encrypted).toBe(false);
    // Aucune réservation : le mode clair n'est pas idempotent et n'a pas changé.
    const claims = await db
      .select()
      .from(uploadIdempotency)
      .where(eq(uploadIdempotency.userId, alice.id));
    expect(claims).toHaveLength(0);
  });

  it('10 bis. un import chiffré sans clé est refusé', async () => {
    const { alice, conversation } = await pair('IdemNoKey', 'IdemPeer');
    const response = await upload({
      token: alice.token,
      conversationId: conversation.id,
      content: Buffer.from('CIPHERTEXT-NO-KEY'),
    }).expect(400);
    expect(String(response.body.message)).toContain('idempotence');
    expect(await uploadsOf(alice.id)).toHaveLength(0);
  });

  it('11. la clé survit à une nouvelle session du client', async () => {
    const { alice, conversation } = await pair('IdemRestart', 'IdemPeer');
    const key = `${randomUUID()}:media`;
    const content = Buffer.from('CIPHERTEXT-RESTART');

    const first = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);
    written.push(first.body.url.replace(/^\//, ''));

    // Nouvelle connexion (jeton neuf, autre contexte HTTP) : seul l'état
    // persistant peut rendre le même identifiant.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: alice.email, password: 'password123' })
      .expect(200);
    const retry = await upload({
      token: login.body.accessToken as string,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(await uploadsOf(alice.id)).toHaveLength(1);
  });

  it('12. les réservations jamais abouties sont nettoyées avec leur blob', async () => {
    const { alice, conversation } = await pair('IdemSweep', 'IdemPeer');
    const folder = `${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const storedUrl = `/uploads/${folder}/${randomUUID()}.bin`;
    await mkdir(join(process.cwd(), 'uploads', folder), { recursive: true });
    await writeFile(join(process.cwd(), storedUrl.slice(1)), 'ORPHELIN');
    await db.insert(uploadIdempotency).values({
      userId: alice.id,
      key: 'orpheline:media',
      conversationId: conversation.id,
      contentSha256: createHash('sha256').update('ORPHELIN').digest('hex'),
      size: 8,
      storedUrl,
      kind: 'IMAGE',
      attemptToken: randomUUID(),
      state: 'pending',
      updatedAt: new Date(Date.now() - 48 * 60 * 60_000),
    });

    expect(await app.get(UploadsService).purgeStaleClaims()).toBeGreaterThan(0);

    expect(existsSync(join(process.cwd(), storedUrl.slice(1)))).toBe(false);
    expect(await claimsOf(alice.id, 'orpheline:media')).toHaveLength(0);
  });

  it('13. un blob disparu n’est jamais annoncé réussi', async () => {
    const { alice, conversation } = await pair('IdemGone', 'IdemPeer');
    const content = Buffer.from('CIPHERTEXT-GONE');
    const key = `${randomUUID()}:media`;

    const first = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);
    const stored = await storedOf(alice.id, key);
    written.push(stored.replace(/^\//, ''));

    // Le blob a été perdu (disque, purge manuelle) mais la réservation dit done.
    await rm(onDisk(stored), { force: true });
    expect(existsSync(onDisk(stored))).toBe(false);

    const retry = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    // Nouvel identifiant, et cette fois le fichier existe vraiment.
    expect(retry.body.id).not.toBe(first.body.id);
    const replaced = await storedOf(alice.id, key);
    written.push(replaced.replace(/^\//, ''));
    expect(existsSync(onDisk(replaced))).toBe(true);
    expect(readFileSync(onDisk(replaced)).equals(content)).toBe(true);
    const [claim] = await claimsOf(alice.id, key);
    expect(claim.state).toBe('done');
    expect(claim.uploadId).toBe(retry.body.id);
  });

  it('7 ter. erreur de stockage : aucune réussite annoncée, la clé reste utilisable', async () => {
    const { alice, conversation } = await pair('IdemWriteFail', 'IdemPeer');
    const key = `${randomUUID()}:media`;
    const content = Buffer.from('CIPHERTEXT-AFTER-FAILURE');

    // Réservation posée puis écriture perdue : c'est l'état laissé par une
    // erreur de disque (ou un arrêt avant écriture). Aucun fichier, aucune ligne.
    const folder = `${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const storedUrl = `/uploads/${folder}/${randomUUID()}.bin`;
    await db.insert(uploadIdempotency).values({
      userId: alice.id,
      key,
      conversationId: conversation.id,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      storedUrl,
      kind: 'IMAGE',
      attemptToken: randomUUID(),
      state: 'pending',
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    expect(existsSync(onDisk(storedUrl))).toBe(false);

    const response = await upload({
      token: alice.token,
      key,
      conversationId: conversation.id,
      content,
    }).expect(201);

    // Ce n'est qu'ici que le blob existe — et il est complet.
    const current = await storedOf(alice.id, key);
    written.push(current.replace(/^\//, ''));
    expect(response.body.id).toBeTruthy();
    expect(readFileSync(onDisk(current)).equals(content)).toBe(true);
    expect(existsSync(onDisk(storedUrl))).toBe(false);
    expect(await uploadsOf(alice.id)).toHaveLength(1);
  });
});
