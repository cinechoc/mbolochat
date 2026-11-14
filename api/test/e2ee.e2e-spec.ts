import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import {
  conversations,
  e2eeDevices,
  messages,
  pushTokens,
  refreshTokens,
} from '../src/db/schema.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';

process.env.E2EE_ENABLED = 'true';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const otk = (fill: number, keyId: string) => ({ keyId, key: key(fill) });

describe('Fondations E2EE (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  const suffix = Date.now();
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get<Database>(DRIZZLE);
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    process.env.E2EE_ENABLED = 'false';
    await app.close();
  });

  const register = async (name: string) => {
    counter += 1;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'E2ee',
        email: `${name.toLowerCase()}_e2ee_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    return {
      id: response.body.user.id as string,
      email: `${name.toLowerCase()}_e2ee_${suffix}_${counter}@e2e.dev`,
      token: response.body.accessToken as string,
      refreshToken: response.body.refreshToken as string,
    };
  };

  const login = async (identifier: string) => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: identifier, password: 'password123' })
      .expect(200);
    return {
      token: response.body.accessToken as string,
      refreshToken: response.body.refreshToken as string,
    };
  };

  const registerDevice = async (
    token: string,
    fill: number,
    prefix: string,
  ): Promise<{ deviceId: string; replaced: boolean }> => {
    const response = await request(app.getHttpServer())
      .post('/e2ee/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({
        identityKey: key(fill),
        signingKey: key(fill + 1),
        oneTimeKeys: [otk(fill + 2, `${prefix}-1`), otk(fill + 3, `${prefix}-2`)],
      })
      .expect(201);
    return response.body;
  };

  it('publie les clés, bascule la conversation et refuse le clair', async () => {
    const alice = await register('Alice');
    const bob = await register('Bob');
    const conversationsService = app.get(ConversationsService);
    const conversation = await conversationsService.create(alice.id, [bob.id]);

    const aliceDevice = await registerDevice(alice.token, 10, 'alice');
    expect(aliceDevice.deviceId).toMatch(/^[0-9a-f]+$/);
    const bobDevice = await registerDevice(bob.token, 20, 'bob');

    const [state] = await db
      .select({ e2eeSince: conversations.e2eeSince })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    expect(state?.e2eeSince).not.toBeNull();

    await expect(
      conversationsService.createMessage(
        conversation.id,
        alice.id,
        'message en clair',
      ),
    ).rejects.toThrow(/clair/i);

    const envelope = Buffer.from('enveloppe-opaque-sentinelle').toString('base64');
    const created = await conversationsService.createMessage(
      conversation.id,
      alice.id,
      '',
      undefined,
      'e2ee-client-1',
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
    expect(created.encryption).toBe('v1');
    expect(created.content).toBe('');
    expect(created.payload).toBe(envelope);

    const [stored] = await db
      .select({ content: messages.content, payload: messages.payload })
      .from(messages)
      .where(eq(messages.id, created.id))
      .limit(1);
    expect(stored?.content).toBe('');
    expect(stored?.payload).toBe(envelope);
    expect(stored?.content).not.toContain('sentinelle');

    const hits = await conversationsService.searchMessages(
      conversation.id,
      bob.id,
      'sentinelle',
    );
    expect(hits).toHaveLength(0);

    await expect(
      conversationsService.toggleReaction(
        conversation.id,
        created.id,
        bob.id,
        'mbolo-panther-2d/amour',
      ),
    ).rejects.toThrow(/chiffrées/i);

    process.env.E2EE_ENABLED = 'false';
    await expect(
      conversationsService.createMessage(
        conversation.id,
        bob.id,
        '',
        undefined,
        'e2ee-client-off',
        undefined,
        null,
        null,
        'text',
        undefined,
        'v1',
        envelope,
        bobDevice.deviceId,
        'prekey',
      ),
    ).rejects.toThrow(/indisponible/i);
    process.env.E2EE_ENABLED = 'true';

    // Un nouvel appareil (nouveau JWT) révoque l'ancien.
    const secondLogin = await login(alice.email);
    const otherDevice = await registerDevice(secondLogin.token, 30, 'alice2');
    await expect(
      conversationsService.createMessage(
        conversation.id,
        alice.id,
        '',
        undefined,
        'e2ee-client-2',
        undefined,
        null,
        null,
        'text',
        undefined,
        'v1',
        envelope,
        aliceDevice.deviceId,
        'prekey',
      ),
    ).rejects.toThrow(/appareil/i);
    expect(otherDevice.replaced).toBe(true);
    void bobDevice;
  });

  it('ne bascule jamais un groupe en chiffrement (M2 : un à un seulement)', async () => {
    const alice = await register('GAlice');
    const bob = await register('GBob');
    const carol = await register('GCarol');
    const conversationsService = app.get(ConversationsService);
    const group = await conversationsService.create(
      alice.id,
      [bob.id, carol.id],
      'GROUP',
      'Groupe scellé',
    );

    await registerDevice(alice.token, 40, 'galice');
    await registerDevice(bob.token, 50, 'gbob');
    await registerDevice(carol.token, 60, 'gcarol');

    const [state] = await db
      .select({ e2eeSince: conversations.e2eeSince })
      .from(conversations)
      .where(eq(conversations.id, group.id))
      .limit(1);
    expect(state?.e2eeSince).toBeNull();

    // Le clair reste accepté dans un groupe non basculé.
    const plain = await conversationsService.createMessage(
      group.id,
      alice.id,
      'bonjour le groupe',
    );
    expect(plain.encryption).toBe('none');
  });

  it('bascule une conversation directe créée après l’enregistrement des appareils', async () => {
    const alice = await register('DAlice');
    const bob = await register('DBob');
    await registerDevice(alice.token, 70, 'dalice');
    await registerDevice(bob.token, 80, 'dbob');

    const conversationsService = app.get(ConversationsService);
    const conversation = await conversationsService.create(alice.id, [bob.id]);

    const [state] = await db
      .select({ e2eeSince: conversations.e2eeSince })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    expect(state?.e2eeSince).not.toBeNull();

    await expect(
      conversationsService.createMessage(conversation.id, alice.id, 'clair interdit'),
    ).rejects.toThrow(/clair/i);
  });

  it('consomme les clés à usage unique et filtre les conversations communes', async () => {
    const alice = await register('AliceKeys');
    const bob = await register('BobKeys');
    const carol = await register('CarolKeys');
    const conversationsService = app.get(ConversationsService);
    const conversation = await conversationsService.create(alice.id, [bob.id]);
    void conversation;
    await registerDevice(alice.token, 40, 'alicek');
    await registerDevice(bob.token, 50, 'bobk');

    const first = await request(app.getHttpServer())
      .get(`/e2ee/users/${bob.id}/keys`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(first.body.oneTimeKey?.keyId).toBe('bobk-1');
    const second = await request(app.getHttpServer())
      .get(`/e2ee/users/${bob.id}/keys`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(second.body.oneTimeKey?.keyId).toBe('bobk-2');
    const third = await request(app.getHttpServer())
      .get(`/e2ee/users/${bob.id}/keys`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(third.body.oneTimeKey).toBeNull();

    await request(app.getHttpServer())
      .get(`/e2ee/users/${bob.id}/keys`)
      .set('Authorization', `Bearer ${carol.token}`)
      .expect(403);
  });

  it('un nouvel appareil révoque les sessions et appareils E2EE précédents', async () => {
    const alice = await register('AliceDevice');
    const bob = await register('BobDevice');
    const conversationsService = app.get(ConversationsService);
    await conversationsService.create(alice.id, [bob.id]);
    await registerDevice(alice.token, 60, 'aliceD');
    await registerDevice(bob.token, 70, 'bobD');

    const secondLogin = await login(alice.email);
    await registerDevice(secondLogin.token, 80, 'aliceD2');

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: alice.refreshToken })
      .expect(401);

    const devices = await db
      .select({ deviceId: e2eeDevices.deviceId, revokedAt: e2eeDevices.revokedAt })
      .from(e2eeDevices)
      .where(eq(e2eeDevices.userId, alice.id));
    expect(devices).toHaveLength(2);
    expect(devices.filter((device) => device.revokedAt === null)).toHaveLength(1);

    const sessions = await db
      .select({ deviceId: refreshTokens.deviceId, revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, alice.id));
    const activeSessions = sessions.filter((session) => session.revokedAt === null);
    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0].deviceId).not.toBeNull();
  });

  it('publie les signatures/fallback et nettoie les push tokens', async () => {
    const alice = await register('AliceSig');
    const bob = await register('BobSig');
    const conversationsService = app.get(ConversationsService);
    const conversation = await conversationsService.create(alice.id, [bob.id]);
    void conversation;
    const signature = Buffer.alloc(64, 9).toString('base64');
    await request(app.getHttpServer())
      .post('/e2ee/devices')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        identityKey: key(90),
        signingKey: key(91),
        fallbackPrekey: key(92),
        fallbackPrekeySignature: signature,
        fallbackPrekeyKeyId: 'fallback-1',
        oneTimeKeys: [{ ...otk(93, 'signed-1'), signature }],
      })
      .expect(201);
    await registerDevice(bob.token, 94, 'bobsig');

    const status = await request(app.getHttpServer())
      .get('/e2ee/status')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(status.body.prekeysRemaining).toBe(1);
    expect(status.body.fallbackAvailable).toBe(true);

    const first = await request(app.getHttpServer())
      .get(`/e2ee/users/${alice.id}/keys`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(first.body.oneTimeKey.signature).toBe(signature);

    const second = await request(app.getHttpServer())
      .get(`/e2ee/users/${alice.id}/keys`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(second.body.oneTimeKey).toBeNull();
    expect(second.body.fallback.key).toBe(key(92));
    expect(second.body.fallback.signature).toBe(signature);

    await request(app.getHttpServer())
      .post('/e2ee/devices/prekeys')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        oneTimeKeys: [{ ...otk(96, 'replenished-1'), signature }],
      })
      .expect(201);
    const replenished = await request(app.getHttpServer())
      .get(`/e2ee/users/${alice.id}/keys`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(replenished.body.oneTimeKey.keyId).toBe('replenished-1');

    await request(app.getHttpServer())
      .post('/users/me/push-token')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ token: 'ExponentPushToken[old-device]', platform: 'android' })
      .expect(201);
    const newLogin = await login(alice.email);
    await registerDevice(newLogin.token, 95, 'alicesig2');
    const remaining = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, alice.id));
    expect(remaining.map((row) => row.token)).not.toContain('ExponentPushToken[old-device]');

    await request(app.getHttpServer())
      .post('/users/me/push-token')
      .set('Authorization', `Bearer ${newLogin.token}`)
      .send({ token: 'ExponentPushToken[new-device]', platform: 'android' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${newLogin.token}`)
      .send({ refreshToken: newLogin.refreshToken })
      .expect(204);
    const afterLogout = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, alice.id));
    expect(afterLogout.map((row) => row.token)).not.toContain('ExponentPushToken[new-device]');
  });

  it('conserve le comportement historique quand le drapeau est coupé', async () => {
    process.env.E2EE_ENABLED = 'false';
    const alice = await register('AliceOff');
    const second = await login(alice.email);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: alice.refreshToken })
      .expect(200);

    await db
      .update(refreshTokens)
      .set({ deviceId: null })
      .where(eq(refreshTokens.userId, alice.id));
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: second.refreshToken })
      .expect(200);

    const conversationsService = app.get(ConversationsService);
    const bob = await register('BobOff');
    const conversation = await conversationsService.create(alice.id, [bob.id]);
    const created = await conversationsService.createMessage(
      conversation.id,
      alice.id,
      'message clair historique',
    );
    expect(created.content).toBe('message clair historique');
    expect(created.encryption).toBe('none');

    await request(app.getHttpServer())
      .get('/e2ee/status')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
    process.env.E2EE_ENABLED = 'true';
  });

  it('refuse les endpoints quand le drapeau est désactivé', async () => {
    const alice = await register('AliceFlag');
    process.env.E2EE_ENABLED = 'false';
    await request(app.getHttpServer())
      .get('/e2ee/status')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
    process.env.E2EE_ENABLED = 'true';
  });
});
