import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';

describe('MboloChat API (e2e)', () => {
  let app: INestApplication;
  const suffix = Date.now();

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

  let emailCounter = 0;

  const registerBody = (firstName: string, lastName: string) => {
    emailCounter += 1;
    return {
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}_${lastName.toLowerCase()}_${suffix}_${emailCounter}@e2e.dev`,
      password: 'password123',
      birthday: '1995-06-15',
      gender: 'FEMALE',
    };
  };

  const register = (firstName: string, lastName: string) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send(registerBody(firstName, lastName))
      .expect(201);

  it('supports the full messaging flow', async () => {
    const alice = (await register('Alice', 'Martin')).body;
    const bob = (await register('Bob', 'Durand')).body;
    alice.token = alice.accessToken;
    bob.token = bob.accessToken;

    expect(alice.user.username).toMatch(/^alice\.martin/);
    expect(alice.user.displayName).toBe('Alice Martin');

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: bob.user.username, password: 'password123' })
      .expect(200);
    expect(login.body.accessToken).toBeTruthy();

    const search = await request(app.getHttpServer())
      .get('/users/search')
      .query({ q: bob.user.username })
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(search.body).toHaveLength(1);
    expect(search.body[0].id).toBe(bob.user.id);

    const conversation = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);
    expect(conversation.body.type).toBe('DIRECT');
    expect(conversation.body.members).toHaveLength(2);

    const again = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);
    expect(again.body.id).toBe(conversation.body.id);

    const conversationsService = app.get(ConversationsService);
    await conversationsService.createMessage(conversation.body.id, alice.user.id, 'Salut Bob !');

    const messages = await request(app.getHttpServer())
      .get(`/conversations/${conversation.body.id}/messages`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(messages.body).toHaveLength(1);
    expect(messages.body[0].content).toBe('Salut Bob !');
    expect(messages.body[0].sender.id).toBe(alice.user.id);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/conversations').expect(401);
  });

  it('rejects duplicate emails', async () => {
    const body = registerBody('Emma', 'Petit');
    await request(app.getHttpServer()).post('/auth/register').send(body).expect(201);
    await request(app.getHttpServer()).post('/auth/register').send(body).expect(409);
  });

  it('generates unique usernames for identical names', async () => {
    const first = (await register('Jean', 'Dupont')).body;
    const second = (await register('Jean', 'Dupont')).body;

    expect(first.user.username).toMatch(/^jean\.dupont/);
    expect(second.user.username).toMatch(/^jean\.dupont/);
    expect(second.user.username).not.toBe(first.user.username);
    expect(second.user.displayName).toBe('Jean Dupont');
  });

  it('rejects underage registrations', async () => {
    const recentYear = new Date().getFullYear() - 10;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        ...registerBody('Young', 'Kid'),
        birthday: `${recentYear}-01-01`,
      })
      .expect(400);
  });

  it('resets a forgotten password with a 6-digit code', async () => {
    const user = (await register('Nina', 'Rossi')).body;

    const forgot = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ emailOrUsername: user.user.username })
      .expect(200);
    expect(forgot.body.devCode).toMatch(/^\d{6}$/);

    const wrongCode = forgot.body.devCode === '000000' ? '111111' : '000000';
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ emailOrUsername: user.user.username, code: wrongCode, newPassword: 'newpassword123' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        emailOrUsername: user.user.username,
        code: forgot.body.devCode,
        newPassword: 'newpassword123',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.user.username, password: 'newpassword123' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.user.username, password: 'password123' })
      .expect(401);
  });

  it('does not reveal unknown accounts and rejects invalid reset codes', async () => {
    const forgotUnknown = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ emailOrUsername: 'inconnu.introuvable' })
      .expect(200);
    expect(forgotUnknown.body.devCode).toBeUndefined();

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ emailOrUsername: 'inconnu.introuvable', code: '123456', newPassword: 'whatever123' })
      .expect(400);

    const user = (await register('Omar', 'Blanc')).body;
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ emailOrUsername: user.user.username, code: '123456', newPassword: 'whatever123' })
      .expect(400);
  });
});
