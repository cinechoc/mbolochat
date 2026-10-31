import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { users } from '../src/db/schema.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { AuthService } from '../src/auth/auth.service.js';

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
    return {
      ...response.body.user,
      token: response.body.accessToken as string,
      refreshToken: response.body.refreshToken as string,
    };
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

  it('applique qui peut écrire et qui peut ajouter en groupe', async () => {
    const alice = await register('Carla');
    const bob = await register('Dany');
    const carol = await register('Eva');

    await request(app.getHttpServer())
      .patch('/users/me/settings')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ privacy: { write: 'nobody', groupAdd: 'nobody' } })
      .expect(200);

    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.id] })
      .expect(403);

    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ type: 'GROUP', name: 'Test', memberIds: [bob.id] })
      .expect(403);

    await request(app.getHttpServer())
      .patch('/users/me/settings')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ privacy: { write: 'everyone', groupAdd: 'contacts' } })
      .expect(200);

    // Écriture rouverte : le message direct passe.
    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.id] })
      .expect(201);

    // Alice est désormais un contact : elle peut ajouter Bob à un groupe.
    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ type: 'GROUP', name: 'Amis', memberIds: [bob.id] })
      .expect(201);

    // Carol n'a aucune conversation partagée avec Bob : refusée.
    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ type: 'GROUP', name: 'Spam', memberIds: [bob.id] })
      .expect(403);
  });

  it('refuse une position simulée', async () => {
    const user = await register('Ines');
    await request(app.getHttpServer())
      .post('/users/me/location')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ latitude: 0.39, longitude: 9.45, mocked: true })
      .expect(400);
  });

  it('renseigne une naissance mineure une seule fois et applique les défauts', async () => {
    const user = await register('Junior');
    const database = app.get<Database>(DRIZZLE);
    // Compte ancien sans date de naissance.
    await database.update(users).set({ birthday: null }).where(eq(users.id, user.id));

    const settings = await request(app.getHttpServer())
      .post('/users/me/birthdate')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ birthday: '2012-01-01' })
      .expect(201);
    expect(settings.body.age).toBeGreaterThanOrEqual(13);
    expect(settings.body.privacy.discoverability).toBe('contacts');
    expect(settings.body.privacy.groupAdd).toBe('contacts');

    await request(app.getHttpServer())
      .post('/users/me/birthdate')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ birthday: '2012-01-01' })
      .expect(400);
  });

  it('liste et révoque les sessions, protège le mot de passe', async () => {
    const user = await register('Lina');
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .set('x-device-name', 'Phone test')
      .set('x-platform', 'android')
      .send({ emailOrUsername: user.username, password: 'password123' })
      .expect(200);

    const sessions = await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(sessions.body.length).toBeGreaterThanOrEqual(2);
    const device = sessions.body.find((entry: any) => entry.deviceName === 'Phone test');
    expect(device).toBeTruthy();

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${device.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ currentPassword: 'mauvais', newPassword: 'nouveaupass123' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ currentPassword: 'password123', newPassword: 'nouveaupass123' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.username, password: 'password123' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.username, password: 'nouveaupass123' })
      .expect(200);
  });

  it('supprime le compte après 30 jours, annulable en se reconnectant', async () => {
    const user = await register('Malo');
    await request(app.getHttpServer())
      .delete('/auth/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: 'mauvais' })
      .expect(401);
    await request(app.getHttpServer())
      .delete('/auth/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: 'password123' })
      .expect(200);

    // Reconnexion dans les 30 jours : la suppression est annulée.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.username, password: 'password123' })
      .expect(200);

    await request(app.getHttpServer())
      .delete('/auth/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: 'password123' })
      .expect(200);

    const database = app.get<Database>(DRIZZLE);
    await database
      .update(users)
      .set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(users.id, user.id));
    const purged = await app.get(AuthService).purgeExpiredDeletions();
    expect(purged).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.username, password: 'password123' })
      .expect(401);
    const [row] = await database.select().from(users).where(eq(users.id, user.id));
    expect(row.displayName).toBe('Compte supprimé');
    expect(row.username.startsWith('deleted_')).toBe(true);
  });

  it('coupe typing et accusés de lecture côté serveur', async () => {
    const alice = await register('Fanny');
    const bob = await register('Gaston');
    const conversation = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.id] })
      .expect(201);

    if (!app.getHttpServer().listening) {
      await app.listen(0);
    }
    const { port } = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const connect = (token: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = io(base, { auth: { token }, transports: ['websocket'], forceNew: true });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      });
    const aliceSocket = await connect(alice.token);
    const bobSocket = await connect(bob.token);
    const join = (socket: Socket) =>
      new Promise<void>((resolve) =>
        socket.emit('conversation:join', { conversationId: conversation.body.id }, () => resolve()),
      );
    await join(aliceSocket);
    await join(bobSocket);

    const wait = (socket: Socket, event: string, ms = 400) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        socket.once(event, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    await request(app.getHttpServer())
      .patch('/users/me/settings')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ typingIndicator: false, readReceipts: false })
      .expect(200);

    bobSocket.emit('typing', { conversationId: conversation.body.id, text: 'coucou' });
    expect(await wait(aliceSocket, 'typing')).toBe(false);

    const conversations = app.get(ConversationsService);
    await conversations.createMessage(conversation.body.id, alice.id, 'Message à lire');
    bobSocket.emit('message:read', { conversationId: conversation.body.id });
    expect(await wait(aliceSocket, 'read')).toBe(false);
    expect(await wait(aliceSocket, 'receipt')).toBe(false);

    await request(app.getHttpServer())
      .patch('/users/me/settings')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ typingIndicator: true, readReceipts: true })
      .expect(200);

    bobSocket.emit('typing', { conversationId: conversation.body.id, text: 'me revoilà' });
    expect(await wait(aliceSocket, 'typing')).toBe(true);

    bobSocket.emit('message:read', { conversationId: conversation.body.id });
    expect(await wait(aliceSocket, 'read')).toBe(true);

    aliceSocket.close();
    bobSocket.close();
  });
});
