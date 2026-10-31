import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';

describe('Confidentialité du profil (e2e)', () => {
  let app: INestApplication;
  const suffix = Date.now();
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await migrate(app.get<Database>(DRIZZLE), { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await app.close();
  });

  const register = async (firstName: string) => {
    counter += 1;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName,
        lastName: 'Privacy',
        email: `${firstName.toLowerCase()}_privacy_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    return { ...response.body.user, token: response.body.accessToken as string };
  };

  it('refuse toute tentative de fixer la ville depuis le client', async () => {
    const alice = await register('Alice');
    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ city: 'Libreville' })
      .expect(400);
  });

  it('filtre photo, bio, âge et découverte selon la relation', async () => {
    const alice = await register('Bea');
    const bob = await register('Bruno');

    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ bio: 'Bio de Bruno' })
      .expect(200);

    const settings = await request(app.getHttpServer())
      .patch('/users/me/settings')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ privacy: { profile: 'nobody', discoverability: 'contacts' } })
      .expect(200);
    expect(settings.body.privacy.profile).toBe('nobody');
    expect(settings.body.privacy.discoverability).toBe('contacts');

    // Inconnus : introuvable, photo/bio/âge masqués, préférences absentes.
    const search = await request(app.getHttpServer())
      .get('/users/search')
      .query({ q: bob.username })
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(search.body).toHaveLength(0);

    const hidden = await request(app.getHttpServer())
      .get(`/users/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(hidden.body.bio).toBeNull();
    expect(hidden.body.avatarUrl).toBeNull();
    expect(hidden.body.age).toBeNull();
    expect(hidden.body.notificationsEnabled).toBeUndefined();

    // Son propre profil reste complet.
    const own = await request(app.getHttpServer())
      .get(`/users/${bob.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(own.body.bio).toBe('Bio de Bruno');
    expect(own.body.age).toBeGreaterThanOrEqual(30);

    // Une conversation partagée en fait un contact : la recherche le trouve,
    // mais la visibilité « personne » protège encore le profil.
    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.id] })
      .expect(201);

    const foundAsContact = await request(app.getHttpServer())
      .get('/users/search')
      .query({ q: bob.username })
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(foundAsContact.body).toHaveLength(1);

    const stillHidden = await request(app.getHttpServer())
      .get(`/users/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(stillHidden.body.bio).toBeNull();

    await request(app.getHttpServer())
      .patch('/users/me/settings')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ privacy: { profile: 'contacts' } })
      .expect(200);

    const visible = await request(app.getHttpServer())
      .get(`/users/${bob.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(visible.body.bio).toBe('Bio de Bruno');
    expect(visible.body.age).toBeGreaterThanOrEqual(30);
  });
});
