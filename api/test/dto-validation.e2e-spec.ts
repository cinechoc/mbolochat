import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { json, urlencoded } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { pushTokens } from '../src/db/schema.js';

/**
 * DTO des corps bruts (Phase 3, B1/B2) : bornes de longueur et de type sur
 * `PATCH /users/me`, jetons push, ajout de membres et jeton de
 * rafraîchissement — sans changer les réponses métier attendues (rejet
 * explicite de la ville, 401 sans jeton de rafraîchissement, etc.).
 *
 * Sur la vraie base PostgreSQL, via les routes HTTP réelles (JWT inclus).
 */
describe('Validation des DTO (profils, push, membres, refresh)', () => {
  let app: INestApplication;
  let db: Database;
  let conversations: ConversationsService;
  const suffix = Date.now();
  let counter = 0;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    }
    await app.close();
  });

  const register = async (name: string) => {
    counter += 1;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Dto',
        email: `${name.toLowerCase()}_dto_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id, token: response.body.accessToken as string, refreshToken: response.body.refreshToken as string };
  };

  describe('PATCH /users/me', () => {
    it('accepte un profil valide (nom, bio, booléens)', async () => {
      const alice = await register('DtoValid');
      const response = await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ displayName: 'Nouveau Nom', bio: 'Salut', notificationsEnabled: false })
        .expect(200);
      expect(response.body.displayName).toBe('Nouveau Nom');
      expect(response.body.bio).toBe('Salut');
    });

    it('refuse un nom trop long, une bio trop longue et un type incorrect', async () => {
      const alice = await register('DtoLong');
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ displayName: 'x'.repeat(49) })
        .expect(400);
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ bio: 'x'.repeat(201) })
        .expect(400);
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ displayName: 42 })
        .expect(400);
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ notificationsEnabled: 'oui' })
        .expect(400);
    });

    it('conserve le rejet explicite des champs interdits (ville)', async () => {
      const alice = await register('DtoCity');
      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ city: 'Paris' })
        .expect(400);
    });
  });

  describe('POST /users/me/push-token', () => {
    it('accepte un jeton Expo valide et refuse les bornes dépassées', async () => {
      const alice = await register('DtoPush');
      await request(app.getHttpServer())
        .post('/users/me/push-token')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ token: 'ExponentPushToken[xxxxxxxxxxxxxxxx]', platform: 'android' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/users/me/push-token')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ token: 'x'.repeat(513) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/users/me/push-token')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ token: '', platform: 'android' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/users/me/push-token')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ token: 'ExponentPushToken[xxxxxxxxxxxxxxxx]', platform: 'windows' })
        .expect(400);
    });
  });

  describe('POST /conversations/:id/members', () => {
    it('refuse memberIds absent, non-tableau ou trop grand', async () => {
      const alice = await register('DtoHost');
      const bob = await register('DtoPeer');
      const group = await conversations.create(alice.id, [bob.id], 'GROUP', 'Groupe dto');
      await request(app.getHttpServer())
        .post(`/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({})
        .expect(400);
      await request(app.getHttpServer())
        .post(`/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: 'pas-un-tableau' })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) })
        .expect(400);
      // Tableau vide : comportement historique conservé (résumé inchangé).
      await request(app.getHttpServer())
        .post(`/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [] })
        .expect(201);
    });
  });

  describe('POST /auth/refresh et /auth/logout', () => {
    it('sans jeton : 401 pour refresh (inchangé), 204 pour logout (inchangé)', async () => {
      await request(app.getHttpServer()).post('/auth/refresh').send({}).expect(401);
      const alice = await register('DtoRefresh');
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({})
        .expect(204);
    });

    it('refuse un jeton de plus de 512 caractères', async () => {
      const alice = await register('DtoRefreshLong');
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'x'.repeat(513) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ refreshToken: 'x'.repeat(513) })
        .expect(400);
    });
  });
});
