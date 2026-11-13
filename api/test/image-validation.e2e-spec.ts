import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { json, urlencoded } from 'express';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { pushTokens } from '../src/db/schema.js';

/**
 * Validation binaire des avatars et photos de groupe (Phase 2, A2/A3) :
 * signatures JPEG/PNG/WebP vérifiées sur le contenu réel, SVG/HTML déguisés
 * refusés, base64 invalide refusé, taille contrôlée avant et après décodage,
 * extension déduite du contenu (jamais du MIME déclaré), écriture complète
 * avant publication de l'URL.
 *
 * Sur la vraie base PostgreSQL, via les routes HTTP réelles (JWT inclus).
 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.from('RIFF\x04\x00\x00\x00WEBPVP8 ', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!DOCTYPE html><html><body>piège</body></html>');

describe('Validation binaire des images (avatar et photo de groupe)', () => {
  let app: INestApplication;
  let db: Database;
  let conversations: ConversationsService;
  const suffix = Date.now();
  let counter = 0;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Même configuration de parseurs que `main.ts` (3 Mo), sinon le corps
    // base64 d'une image de 2 Mo serait rejeté en 413 avant les contrôles.
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(json({ limit: '3mb' }));
    app.use(urlencoded({ extended: true, limit: '3mb' }));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get<Database>(DRIZZLE);
    await migrate(db, { migrationsFolder: 'drizzle' });
    conversations = app.get(ConversationsService);
  });

  afterAll(async () => {
    for (const userId of createdUsers) {
      await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
      for (const ext of ['jpg', 'png', 'webp']) {
        rmSync(join(process.cwd(), 'uploads', `${userId}.${ext}`), { force: true });
      }
    }
    await app.close();
  });

  const register = async (name: string) => {
    counter += 1;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Image',
        email: `${name.toLowerCase()}_img_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id, token: response.body.accessToken as string };
  };

  const uploadAvatar = (token: string, data: string, mimeType = 'image/jpeg') =>
    request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ data, mimeType });

  describe('POST /users/me/avatar', () => {
    it('accepte un JPEG et publie une URL .jpg dont le fichier est complet', async () => {
      const alice = await register('ImgJpeg');
      const response = await uploadAvatar(alice.token, JPEG.toString('base64')).expect(201);
      // L'URL publiée est signée (intercepteur médias) : elle embarque le
      // chemin `/uploads/<id>.jpg` encodé dans le paramètre `f`.
      expect(response.body.avatarUrl).toContain(
        `/media?f=${encodeURIComponent(`/uploads/${alice.id}.jpg`)}`,
      );
      const stored = join(process.cwd(), 'uploads', `${alice.id}.jpg`);
      expect(existsSync(stored)).toBe(true);
      expect(readFileSync(stored).equals(JPEG)).toBe(true);
    });

    it('déduit l’extension du contenu, pas du MIME déclaré (PNG déclaré JPEG)', async () => {
      const alice = await register('ImgPng');
      const response = await uploadAvatar(alice.token, PNG.toString('base64'), 'image/jpeg').expect(201);
      expect(response.body.avatarUrl).toContain(
        `/media?f=${encodeURIComponent(`/uploads/${alice.id}.png`)}`,
      );
      expect(existsSync(join(process.cwd(), 'uploads', `${alice.id}.png`))).toBe(true);
    });

    it('accepte un WebP', async () => {
      const alice = await register('ImgWebp');
      const response = await uploadAvatar(alice.token, WEBP.toString('base64'), 'image/webp').expect(201);
      expect(response.body.avatarUrl).toContain(
        `/media?f=${encodeURIComponent(`/uploads/${alice.id}.webp`)}`,
      );
    });

    it('refuse un SVG déguisé en JPEG (400, aucun fichier)', async () => {
      const alice = await register('ImgSvg');
      await uploadAvatar(alice.token, SVG.toString('base64')).expect(400);
      expect(existsSync(join(process.cwd(), 'uploads', `${alice.id}.jpg`))).toBe(false);
    });

    it('refuse un HTML déguisé et un base64 invalide', async () => {
      const alice = await register('ImgHtml');
      await uploadAvatar(alice.token, HTML.toString('base64')).expect(400);
      await uploadAvatar(alice.token, 'pas du base64 !!!').expect(400);
      await uploadAvatar(alice.token, 'QQ==\n').expect(400);
    });

    it('refuse une image de plus de 2 Mo décodés', async () => {
      const alice = await register('ImgBig');
      const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
      await uploadAvatar(alice.token, big.toString('base64')).expect(400);
    });
  });

  describe('POST /conversations/:id/photo', () => {
    const setupGroup = async () => {
      const alice = await register('GrpHost');
      const bob = await register('GrpPeer');
      const group = await conversations.create(alice.id, [bob.id], 'GROUP', 'Groupe image');
      return { alice, bob, group };
    };

    const uploadPhoto = (token: string, id: string, data: string, mimeType = 'image/jpeg') =>
      request(app.getHttpServer())
        .post(`/conversations/${id}/photo`)
        .set('Authorization', `Bearer ${token}`)
        .send({ data, mimeType });

    it('accepte un JPEG et stocke group-<id>.jpg complet', async () => {
      const { alice, group } = await setupGroup();
      const response = await uploadPhoto(alice.token, group.id, JPEG.toString('base64')).expect(201);
      expect(response.body.avatarUrl).toContain(
        `/media?f=${encodeURIComponent(`/uploads/group-${group.id}.jpg`)}`,
      );
      const stored = join(process.cwd(), 'uploads', `group-${group.id}.jpg`);
      expect(readFileSync(stored).equals(JPEG)).toBe(true);
      rmSync(stored, { force: true });
    });

    it('refuse un SVG déclaré JPEG et un base64 invalide', async () => {
      const { alice, group } = await setupGroup();
      await uploadPhoto(alice.token, group.id, SVG.toString('base64')).expect(400);
      await uploadPhoto(alice.token, group.id, '****').expect(400);
    });

    it('refuse une image de plus de 2 Mo', async () => {
      const { alice, group } = await setupGroup();
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      await uploadPhoto(alice.token, group.id, big.toString('base64')).expect(400);
    });
  });
});
