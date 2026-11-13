import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';

/**
 * TEMPORAIRE (Phase 4) : sème une conversation de 200 messages pour mesurer
 * le défilement sur un appareil réel. Le test est ignoré par défaut : il
 * n'écrit que si l'identifiant du compte de test de l'appareil est fourni,
 * car cet identifiant est propre à la base utilisée pour la mesure.
 *
 *   PERF_SEED_DEVICE_USER_ID=<uuid> npx vitest run --config ./vitest.config.e2e.ts \
 *     test/perf-seed.e2e-spec.ts
 *
 * À supprimer après les mesures.
 */
const DEVICE_USER_ID = process.env.PERF_SEED_DEVICE_USER_ID?.trim() ?? '';
const describePerf = DEVICE_USER_ID ? describe : describe.skip;

describePerf('Seed perf (temporaire)', () => {
  let app: INestApplication;
  let conversations: ConversationsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const db = app.get<Database>(DRIZZLE);
    await migrate(db, { migrationsFolder: 'drizzle' });
    conversations = app.get(ConversationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('crée un groupe avec 200 messages', async () => {
    const suffix = Date.now();
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'Perf',
        lastName: 'Seed',
        email: `perf_seed_${suffix}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'MALE',
      })
      .expect(201);
    const bobId = response.body.user.id as string;
    const group = await conversations.create(DEVICE_USER_ID, [bobId], 'GROUP', 'Groupe perf');
    for (let i = 0; i < 200; i += 1) {
      const body =
        i % 10 === 0
          ? `Message ${i} — un texte assez long pour occuper plusieurs lignes dans la bulle et tester le calcul des hauteurs variables pendant le défilement de la liste.`
          : `Message ${i}`;
      await conversations.createMessage(
        group.id,
        bobId,
        body,
        undefined,
        `perf-${suffix}-${i}`,
        undefined,
        null,
        null,
        'text',
        undefined,
        undefined,
      );
    }
    console.log(`SEEDED group=${group.id} bob=${bobId} count=200`);
    expect(group.id).toBeTruthy();
  }, 60000);
});
