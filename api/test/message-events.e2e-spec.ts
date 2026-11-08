import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Server } from 'socket.io';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { MessageEventsDispatcher } from '../src/chat/message-events.dispatcher.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import {
  conversationMembers,
  messageEvents,
  messages,
  pushTokens,
} from '../src/db/schema.js';
import { MediaService } from '../src/media/media.service.js';
import { MessageEventsService } from '../src/message-events/message-events.service.js';
import { PushService } from '../src/push/push.service.js';

/**
 * Journal des effets secondaires d'un message (étape 1.2e).
 *
 * Tout passe par la vraie base PostgreSQL et le vrai service de conversations.
 * Seuls deux éléments sont simulés, faute de pouvoir les instancier ici :
 * - le serveur Socket.IO, remplacé par un enregistreur de `to(...).emit(...)` ;
 * - l'envoi push (appel HTTP vers Expo), remplacé par un espion : on vérifie
 *   combien de notifications logiques sont créées, pas la livraison.
 *
 * Les travailleurs sont pilotés explicitement (`deliverMessage`, `sweep`) :
 * l'état de crash est reconstruit en base, ce qui permet d'observer les lignes
 * réellement persistées.
 */
describe('Effets secondaires des messages (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let conversations: ConversationsService;
  let events: MessageEventsService;
  let push: PushService;
  let dispatcher: MessageEventsDispatcher;
  const suffix = Date.now();
  let counter = 0;

  interface Emission {
    rooms: string[];
    event: string;
    payload: { id?: string } & Record<string, unknown>;
  }
  const emitted: Emission[] = [];
  const sent: { messageId: string; userId: string }[] = [];
  const createdUsers: string[] = [];
  /** Notifications qui doivent échouer au prochain essai (clé message:utilisateur). */
  const failures = new Set<string>();
  /** Destinataires volontairement inéligibles au moment de l'envoi. */
  const skipped = new Set<string>();

  const fakeServer = (sink: Emission[]) =>
    ({
      to: (target: string | string[]) => {
        const rooms = Array.isArray(target) ? target : [target];
        return {
          emit: (event: string, payload: Emission['payload']) => {
            sink.push({ rooms, event, payload });
          },
        };
      },
    }) as unknown as Server;

  /** Attend qu'une condition devienne vraie (envoi push non attendu…). */
  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 3_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Laisse tourner les microtâches d'une passe asynchrone. */
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get<Database>(DRIZZLE);
    await migrate(db, { migrationsFolder: 'drizzle' });
    conversations = app.get(ConversationsService);
    events = app.get(MessageEventsService);
    push = app.get(PushService);
    dispatcher = app.get(MessageEventsDispatcher);

    // Reprise automatique coupée : chaque test décide quand le worker tourne.
    dispatcher.onModuleDestroy();
    dispatcher.attachServer(fakeServer(emitted));
    await flush();
    // Tableau propre : les lignes déposées par d'autres suites n'intéressent pas.
    await db.delete(messageEvents);
    emitted.length = 0;

    vi.spyOn(push, 'notifyForUser').mockImplementation(async (message, userId) => {
      const key = `${message.id}:${userId}`;
      if (failures.has(key)) {
        failures.delete(key);
        throw new Error('Expo 502');
      }
      // La vraie règle d'éligibilité (membre, préférences, jetons) décide :
      // on ne simule que l'appel réseau du fournisseur.
      if (skipped.has(key) || !(await push.canNotify(message, userId))) {
        return false;
      }
      sent.push({ messageId: message.id, userId });
      return true;
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const userId of createdUsers) {
      await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    }
    await app.close();
  });

  beforeEach(() => {
    emitted.length = 0;
    sent.length = 0;
    failures.clear();
    skipped.clear();
  });

  const register = async (name: string) => {
    counter += 1;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Effets',
        email: `${name.toLowerCase()}_m5_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id, token: response.body.accessToken as string };
  };

  /** Un utilisateur joignable par notification. */
  const withPushToken = async (name: string) => {
    const user = await register(name);
    await db.insert(pushTokens).values({
      userId: user.id,
      token: `ExponentPushToken[${name}-${suffix}]`,
      baseUrl: 'http://api.test',
    });
    return user;
  };

  const send = (
    conversationId: string,
    senderId: string,
    content: string,
    clientId: string,
  ) =>
    conversations.createMessage(
      conversationId,
      senderId,
      content,
      undefined,
      clientId,
      undefined,
      null,
      null,
      'text',
      undefined,
      'none',
      undefined,
      undefined,
      undefined,
    );

  const rowsOf = (messageId: string) => events.listForMessage(messageId);
  /** Toutes les lignes d'un message sont closes (ni `pending` ni en cours). */
  const rowsSettled = async (messageId: string) =>
    (await rowsOf(messageId)).every((row) => row.status !== 'pending');
  /** Rattrapage client : `GET /conversations/sync?since=…` (indépendant du journal). */
  const syncSince = async (token: string, since: Date) => {
    const response = await request(app.getHttpServer())
      .get(`/conversations/sync?since=${since.toISOString()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as { id: string }[];
  };
  /**
   * La passerelle tourne aussi pendant ces tests (création de groupe ⇒ message
   * système). On ne regarde donc que les effets du message étudié.
   */
  const emissionsOf = (messageId: string) =>
    emitted.filter((entry) => entry.payload.id === messageId);
  const sendsOf = (messageId: string) => sent.filter((entry) => entry.messageId === messageId);
  const messageCount = async (senderId: string, clientId: string) => {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(sql`${messages.senderId} = ${senderId} and ${messages.clientId} = ${clientId}`);
    return rows.length;
  };

  it('crée un seul message, un seul événement et une notification par destinataire', async () => {
    const alice = await register('Alice');
    const bob = await withPushToken('Bob');
    const carol = await withPushToken('Carol');
    const conversation = await conversations.create(alice.id, [bob.id, carol.id]);

    const message = await send(conversation.id, alice.id, 'bonjour', 'k1');

    // Une seule ligne de message, malgré deux colonnes d'identité.
    expect(await messageCount(alice.id, 'k1')).toBe(1);
    // Effets prévus dès la transaction du message : diffusion + un push par
    // destinataire de l'audience gelée (Bob et Carol, pas l'expéditrice).
    const before = await rowsOf(message.id);
    expect(before.map((row) => row.kind).sort()).toEqual(['push', 'push', 'socket']);
    expect(
      before.filter((row) => row.kind === 'push').map((row) => row.userId).sort(),
    ).toEqual([bob.id, carol.id].sort());
    expect(emissionsOf(message.id)).toHaveLength(0);

    await dispatcher.deliverMessage(message.id);
    await flush();

    // Un seul événement logique, ciblant conversation ouverte + membres.
    const emissions = emissionsOf(message.id);
    expect(emissions).toHaveLength(1);
    expect(emissions[0].event).toBe('message:new');
    expect(emissions[0].rooms).toContain(`conv:${conversation.id}`);
    expect(emissions[0].rooms).toContain(`user:${alice.id}`);
    expect(emissions[0].rooms).toContain(`user:${bob.id}`);
    expect(emissions[0].rooms).toContain(`user:${carol.id}`);
    // L'expéditeur n'est pas notifié, chaque autre membre une fois.
    await waitFor(() => sendsOf(message.id).length === 2);
    expect(sendsOf(message.id).map((entry) => entry.userId).sort()).toEqual(
      [bob.id, carol.id].sort(),
    );

    const after = await rowsOf(message.id);
    expect(after.every((row) => row.status === 'done')).toBe(true);
    expect(after.filter((row) => row.kind === 'push')).toHaveLength(2);

    // Rejouer la même livraison ne réémet ni ne renotifie.
    await dispatcher.deliverMessage(message.id);
    await dispatcher.sweep();
    expect(emissionsOf(message.id)).toHaveLength(1);
    expect(sendsOf(message.id)).toHaveLength(2);
  });

  it('ne rediffuse rien quand la requête d’envoi est répétée', async () => {
    const alice = await register('Repeat');
    const bob = await withPushToken('RepeatBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const first = await send(conversation.id, alice.id, 'une fois', 'k2');
    await dispatcher.deliverMessage(first.id);
    expect(emissionsOf(first.id)).toHaveLength(1);
    const rowsBefore = await rowsOf(first.id);

    // Deuxième envoi du même clientId : même message, aucun nouvel effet.
    const second = await send(conversation.id, alice.id, 'une fois', 'k2');
    expect(second.id).toBe(first.id);
    await dispatcher.deliverMessage(second.id);
    await dispatcher.sweep();

    expect(await messageCount(alice.id, 'k2')).toBe(1);
    expect((await rowsOf(first.id)).length).toBe(rowsBefore.length);
    expect(emissionsOf(first.id)).toHaveLength(1);
    expect(sendsOf(first.id)).toHaveLength(1);
    // Le contenu d'origine n'est pas remplacé par celui du rejeu.
    const [stored] = await db.select().from(messages).where(eq(messages.id, first.id));
    expect(stored.content).toBe('une fois');
  });

  it('absorbe deux créations concurrentes du même clientId', async () => {
    const alice = await register('Race');
    const bob = await withPushToken('RaceBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const [a, b] = await Promise.all([
      send(conversation.id, alice.id, 'course', 'k3'),
      send(conversation.id, alice.id, 'course', 'k3'),
    ]);
    expect(a.id).toBe(b.id);
    expect(await messageCount(alice.id, 'k3')).toBe(1);
    expect((await rowsOf(a.id)).length).toBe(2);

    await Promise.all([dispatcher.deliverMessage(a.id), dispatcher.deliverMessage(b.id)]);
    await flush();
    expect(emissionsOf(a.id)).toHaveLength(1);
    await waitFor(() => sendsOf(a.id).length === 1);
    expect(sendsOf(a.id)).toHaveLength(1);
  });

  it('reprend après un crash entre l’écriture et la diffusion', async () => {
    const alice = await register('Crash');
    const bob = await withPushToken('CrashBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'jamais diffusé', 'k4');
    // État de crash : le message existe, ses effets sont en attente, rien n'est parti.
    expect((await rowsOf(message.id)).every((row) => row.status === 'pending')).toBe(true);
    expect(emissionsOf(message.id)).toHaveLength(0);
    expect(sendsOf(message.id)).toHaveLength(0);

    // « Redémarrage » : un worker neuf reprend les lignes en attente.
    const restarted = new MessageEventsDispatcher(events, conversations, push, app.get(MediaService));
    restarted.attachServer(fakeServer(emitted));
    await restarted.sweep();
    await flush();
    restarted.onModuleDestroy();

    expect(emissionsOf(message.id)).toHaveLength(1);
    expect(sendsOf(message.id)).toEqual([{ messageId: message.id, userId: bob.id }]);
    expect((await rowsOf(message.id)).every((row) => row.status === 'done')).toBe(true);
  });

  it('réémet le socket si le crash suit l’émission, sans doubler le push', async () => {
    const alice = await register('AfterEmit');
    const bob = await withPushToken('AfterEmitBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'émis sans trace', 'k5');
    // État de crash : l'événement est parti, la ligne socket n'a pas été close.
    emitted.push({ rooms: [conversation.id], event: 'message:new', payload: { id: message.id } });

    await dispatcher.sweep();

    // La diffusion est au moins une fois : le client sait reconnaître le message
    // par son identifiant, mais un doublon d'événement reste possible.
    expect(emissionsOf(message.id)).toHaveLength(2);
    // Le push, lui, n'est créé qu'une fois : les lignes ne sont pas dupliquées.
    expect(sendsOf(message.id)).toEqual([{ messageId: message.id, userId: bob.id }]);
    expect(await messageCount(alice.id, 'k5')).toBe(1);
  });

  it('accepte un doublon physique de push dans la seule fenêtre non couvrable', async () => {
    const alice = await register('PushCrash');
    const bob = await withPushToken('PushCrashBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'push accepté', 'k6');
    await dispatcher.deliverMessage(message.id);
    await waitFor(() => sendsOf(message.id).length === 1);
    expect(sendsOf(message.id)).toHaveLength(1);

    // Le fournisseur a accepté, le serveur est tombé avant de clore la ligne.
    await db
      .update(messageEvents)
      .set({ status: 'pending' })
      .where(sql`${messageEvents.messageId} = ${message.id} and ${messageEvents.kind} = 'push'`);

    await dispatcher.sweep();
    await flush();
    await waitFor(() => sendsOf(message.id).length === 2);
    // Deux envois physiques possibles, un seul message : c'est la limite du
    // fournisseur, qui n'offre aucune clé d'idempotence.
    expect(sendsOf(message.id)).toHaveLength(2);
    expect(await messageCount(alice.id, 'k6')).toBe(1);
    expect((await rowsOf(message.id)).every((row) => row.status === 'done')).toBe(true);
  });

  it('n’envoie rien à un destinataire muet ou sans jeton, mais garde sa ligne', async () => {
    const alice = await register('Prefs');
    const bob = await withPushToken('PrefsBob');
    const muted = await withPushToken('PrefsMuted');
    const silentOnly = await register('PrefsNoToken');
    const conversation = await conversations.create(alice.id, [
      bob.id,
      muted.id,
      silentOnly.id,
    ]);
    await db
      .update(conversationMembers)
      .set({ mutedAt: new Date() })
      .where(sql`${conversationMembers.conversationId} = ${conversation.id} and ${conversationMembers.userId} = ${muted.id}`);

    const message = await send(conversation.id, alice.id, 'seulement bob', 'k7');
    await dispatcher.deliverMessage(message.id);
    await waitFor(() => sendsOf(message.id).length === 1);

    // L'audience gelée contient les trois membres (moins l'expéditrice), mais
    // seules les préférences et les jetons décident de l'envoi.
    const pushRows = (await rowsOf(message.id)).filter((row) => row.kind === 'push');
    expect(pushRows.map((row) => row.userId).sort()).toEqual(
      [bob.id, muted.id, silentOnly.id].sort(),
    );
    expect(sendsOf(message.id)).toEqual([{ messageId: message.id, userId: bob.id }]);
  });

  it('n’envoie rien à un utilisateur qui n’est pas membre', async () => {
    const alice = await register('Iso');
    const bob = await withPushToken('IsoBob');
    const outsider = await withPushToken('IsoOutsider');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'privé', 'k8');
    await dispatcher.deliverMessage(message.id);

    expect(sendsOf(message.id).every((entry) => entry.userId !== outsider.id)).toBe(true);
    expect(emissionsOf(message.id)[0].rooms).not.toContain(`user:${outsider.id}`);
    const pushRows = (await rowsOf(message.id)).filter((row) => row.kind === 'push');
    expect(pushRows.map((row) => row.userId)).toEqual([bob.id]);
  });

  it('ne laisse qu’un seul worker gagner la même ligne', async () => {
    const alice = await register('Workers');
    const bob = await withPushToken('WorkersBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'un seul worker', 'k9');
    // Deux instances distinctes : deux processus concurrents.
    const second = new MessageEventsDispatcher(events, conversations, push, app.get(MediaService));
    second.attachServer(fakeServer(emitted));

    await Promise.all([
      dispatcher.deliverMessage(message.id),
      second.deliverMessage(message.id),
    ]);
    await flush();
    await second.sweep();
    await waitFor(() => sendsOf(message.id).length === 1);
    await waitFor(() => rowsSettled(message.id));
    second.onModuleDestroy();

    expect(emissionsOf(message.id)).toHaveLength(1);
    expect(sendsOf(message.id)).toHaveLength(1);
    expect((await rowsOf(message.id)).every((row) => row.status === 'done')).toBe(true);
  });

  it('ne redémarre pas indéfiniment une notification refusée', async () => {
    const alice = await register('Retry');
    const bob = await withPushToken('RetryBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'échec fournisseur', 'k10');
    failures.add(`${message.id}:${bob.id}`);

    await dispatcher.sweep();
    await flush();
    // Premier échec : la ligne reste en attente, avec l'erreur et un report.
    const [pending] = (await rowsOf(message.id)).filter((row) => row.kind === 'push');
    expect(pending.status).toBe('pending');
    expect(pending.lastError).toContain('502');
    expect(pending.attempts).toBe(1);

    // Les tentatives suivantes aboutissent : une seule notification envoyée.
    await db
      .update(messageEvents)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(messageEvents.id, pending.id));
    await dispatcher.sweep();
    await flush();
    expect(sendsOf(message.id)).toHaveLength(1);
    expect((await rowsOf(message.id)).filter((row) => row.kind === 'push')[0].status).toBe('done');
  });

  it('traite les messages système avec le même journal, sans push', async () => {
    const alice = await register('System');
    const bob = await withPushToken('SystemBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const system = await conversations.postSystemMessage(
      conversation.id,
      alice.id,
      'Groupe créé',
    );
    const rows = await rowsOf(system.id);
    expect(rows.map((row) => row.kind)).toEqual(['socket']);

    await dispatcher.deliverMessage(system.id);
    await flush();
    await waitFor(() => emissionsOf(system.id).length === 1);
    expect(emissionsOf(system.id)).toHaveLength(1);
    expect(sendsOf(system.id)).toHaveLength(0);
  });

  it('nettoie les lignes closes sans toucher aux lignes en attente', async () => {
    const alice = await register('Purge');
    const bob = await withPushToken('PurgeBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const finished = await send(conversation.id, alice.id, 'clos', 'k12');
    await dispatcher.deliverMessage(finished.id);
    await waitFor(() => sendsOf(finished.id).length === 1);
    const pending = await send(conversation.id, alice.id, 'en attente', 'k13');

    // Toutes les lignes closes datent de plus de trente jours.
    await db
      .update(messageEvents)
      .set({ updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60_000) })
      .where(eq(messageEvents.messageId, finished.id));

    await events.purgeFinished(30 * 24 * 60 * 60_000);

    expect(await rowsOf(finished.id)).toHaveLength(0);
    expect((await rowsOf(pending.id)).every((row) => row.status === 'pending')).toBe(true);

    // Un abandon de 40 jours survit (trace opérateur), un abandon de 100 jours
    // est purgé : période plus longue que pour les succès.
    const abandoned = await send(conversation.id, alice.id, 'abandonné', 'k22');
    await db
      .update(messageEvents)
      .set({ status: 'skipped', updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60_000) })
      .where(eq(messageEvents.messageId, abandoned.id));
    await events.purgeFinished(30 * 24 * 60 * 60_000);
    expect((await rowsOf(abandoned.id)).length).toBeGreaterThan(0);

    await db
      .update(messageEvents)
      .set({ updatedAt: new Date(Date.now() - 100 * 24 * 60 * 60_000) })
      .where(eq(messageEvents.messageId, abandoned.id));
    await events.purgeFinished(30 * 24 * 60 * 60_000);
    expect(await rowsOf(abandoned.id)).toHaveLength(0);
  });

  it('abandonne visiblement après cinq échecs, sans perdre le message', async () => {
    const alice = await register('Abandon');
    const bob = await withPushToken('AbandonBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'fournisseur muet', 'k14');
    const key = `${message.id}:${bob.id}`;

    // Cinq tentatives qui échouent toutes.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      failures.add(key);
      await db
        .update(messageEvents)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(messageEvents.messageId, message.id));
      await dispatcher.sweep();
    }
    await flush();

    const pushRow = (await rowsOf(message.id)).filter((row) => row.kind === 'push')[0];
    // La ligne existe toujours (rien n'est supprimé) et porte la raison.
    expect(pushRow.status).toBe('skipped');
    expect(pushRow.attempts).toBe(5);
    expect(pushRow.lastError).toContain('502');
    expect(sendsOf(message.id)).toHaveLength(0);

    // Un sixième tour ne la reprend pas : l'abandon est définitif côté worker.
    await db
      .update(messageEvents)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(messageEvents.messageId, message.id));
    await dispatcher.sweep();
    await flush();
    expect((await rowsOf(message.id)).filter((row) => row.kind === 'push')[0].attempts).toBe(5);

    // Le message, lui, reste récupérable par la synchronisation.
    const missed = await syncSince(bob.token, new Date(Date.now() - 60_000));
    expect(missed.some((entry) => entry.id === message.id)).toBe(true);
    expect(await messageCount(alice.id, 'k14')).toBe(1);
  });

  it('récupère un événement abandonné sans recréer le message', async () => {
    const alice = await register('Recover');
    const bob = await withPushToken('RecoverBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'à récupérer', 'k15');
    const key = `${message.id}:${bob.id}`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      failures.add(key);
      await db
        .update(messageEvents)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(messageEvents.messageId, message.id));
      await dispatcher.sweep();
    }
    await flush();
    const abandoned = (await rowsOf(message.id)).filter((row) => row.kind === 'push')[0];
    expect(abandoned.status).toBe('skipped');

    // Reprise administrative : la même ligne repart, avec un compteur neuf.
    const rearmed = await events.retrySkipped({ messageId: message.id });
    expect(rearmed).toBe(1);
    await dispatcher.sweep();
    await waitFor(() => sendsOf(message.id).length === 1);

    expect(sendsOf(message.id)).toHaveLength(1);
    expect((await rowsOf(message.id)).every((row) => row.status === 'done')).toBe(true);
    // Une seule création de message : la reprise ne réinsère rien.
    expect(await messageCount(alice.id, 'k15')).toBe(1);
    expect((await rowsOf(message.id)).length).toBe(2);

    // Un second appel ne réarme rien (plus aucune ligne abandonnée).
    expect(await events.retrySkipped({ messageId: message.id })).toBe(0);
  });

  it('récupère un événement Socket.IO abandonné par la synchronisation', async () => {
    const alice = await register('SocketLost');
    const bob = await register('SocketLostBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'diffusion perdue', 'k16');
    // Diffusion impossible pendant cinq tentatives, puis abandon.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await events.claim(
        (await rowsOf(message.id)).filter((row) => row.kind === 'socket')[0].id,
      );
      if (claimed) {
        await events.reschedule(claimed, claimed.claimToken!, 'gateway absent');
      }
    }
    const socketRow = (await rowsOf(message.id)).filter((row) => row.kind === 'socket')[0];
    expect(socketRow.status).toBe('skipped');
    expect(emissionsOf(message.id)).toHaveLength(0);

    // Aucun destinataire n'a vu l'événement, mais le message est en base : le
    // rattrapage le rend, indépendamment du journal.
    const missed = await syncSince(bob.token, new Date(Date.now() - 60_000));
    expect(missed.some((entry) => entry.id === message.id)).toBe(true);

    // Et l'événement peut être rejoué sans créer un deuxième message.
    expect(await events.retrySkipped({ messageId: message.id, kinds: ['socket'] })).toBe(1);
    await dispatcher.sweep();
    await flush();
    expect(emissionsOf(message.id)).toHaveLength(1);
    expect(await messageCount(alice.id, 'k16')).toBe(1);
  });

  it('ne notifie pas un membre ajouté après l’envoi', async () => {
    const alice = await register('LateAdd');
    const bob = await withPushToken('LateAddBob');
    const carol = await withPushToken('LateAddCarol');
    const late = await withPushToken('LateAddLate');
    const conversation = await conversations.create(alice.id, [bob.id, carol.id]);

    const message = await send(conversation.id, alice.id, 'avant ajout', 'k17');
    // Le nouveau membre arrive après la création du message.
    await conversations.addMembers(conversation.id, alice.id, [late.id]);

    await dispatcher.deliverMessage(message.id);
    await waitFor(() => sendsOf(message.id).length === 2);

    const pushRows = (await rowsOf(message.id)).filter((row) => row.kind === 'push');
    expect(pushRows.map((row) => row.userId).sort()).toEqual([bob.id, carol.id].sort());
    expect(sendsOf(message.id).map((entry) => entry.userId).sort()).toEqual(
      [bob.id, carol.id].sort(),
    );
    expect(sendsOf(message.id).some((entry) => entry.userId === late.id)).toBe(false);

    // Le message suivant, lui, inclut le nouveau membre.
    const next = await send(conversation.id, alice.id, 'après ajout', 'k18');
    expect(
      (await rowsOf(next.id)).filter((row) => row.kind === 'push').map((row) => row.userId).sort(),
    ).toEqual([bob.id, carol.id, late.id].sort());
  });

  it('garde la ligne d’un membre retiré après l’envoi, sans la lui envoyer', async () => {
    const alice = await register('LateRemove');
    const bob = await withPushToken('LateRemoveBob');
    const carol = await withPushToken('LateRemoveCarol');
    const conversation = await conversations.create(alice.id, [bob.id, carol.id]);

    const message = await send(conversation.id, alice.id, 'avant retrait', 'k19');
    // Carol est retirée après la création du message.
    await conversations.removeMember(conversation.id, alice.id, carol.id);

    await dispatcher.deliverMessage(message.id);
    await waitFor(() => sendsOf(message.id).length === 1);
    await waitFor(() => rowsSettled(message.id));
    await flush();

    // L'audience gelée n'est pas réécrite : la ligne de Carol reste.
    const pushRows = (await rowsOf(message.id)).filter((row) => row.kind === 'push');
    expect(pushRows.map((row) => row.userId).sort()).toEqual([bob.id, carol.id].sort());
    // Mais rien n'est envoyé à Carol, qui n'a plus accès à la conversation.
    expect(sendsOf(message.id).map((entry) => entry.userId)).toEqual([bob.id]);
    // Close en `done` avec la raison : ce n'est pas un échec à rejouer.
    const carolRow = pushRows.find((row) => row.userId === carol.id);
    expect(carolRow?.status).toBe('done');
    expect(carolRow?.lastError).toContain('hors audience');
  });

  it('respecte les préférences modifiées entre l’envoi et le dispatch', async () => {
    const alice = await register('PrefsLate');
    const bob = await withPushToken('PrefsLateBob');
    const carol = await withPushToken('PrefsLateCarol');
    const conversation = await conversations.create(alice.id, [bob.id, carol.id]);

    const message = await send(conversation.id, alice.id, 'préférences', 'k20');
    // Bob coupe ses notifications, Carol se met en sourdine, après l'envoi.
    await db.execute(sql`update users set notifications_enabled = false where id = ${bob.id}`);
    await db
      .update(conversationMembers)
      .set({ mutedAt: new Date() })
      .where(sql`${conversationMembers.conversationId} = ${conversation.id} and ${conversationMembers.userId} = ${carol.id}`);

    const dto = await conversations.messageDto(message.id);
    expect(await push.canNotify(dto, bob.id)).toBe(false);
    expect(await push.canNotify(dto, carol.id)).toBe(false);

    await dispatcher.deliverMessage(message.id);
    await waitFor(() => rowsSettled(message.id));
    await flush();

    expect(sendsOf(message.id)).toHaveLength(0);
    expect(
      (await rowsOf(message.id))
        .filter((row) => row.kind === 'push')
        .every((row) => row.status !== 'pending'),
    ).toBe(true);
  });

  it('ne duplique ni destinataire ni événement quand deux créations se courent après', async () => {
    const alice = await register('NoDup');
    const bob = await withPushToken('NoDupBob');
    const carol = await withPushToken('NoDupCarol');
    const conversation = await conversations.create(alice.id, [bob.id, carol.id]);

    const [a, b] = await Promise.all([
      send(conversation.id, alice.id, 'course', 'k21'),
      send(conversation.id, alice.id, 'course', 'k21'),
    ]);
    expect(a.id).toBe(b.id);
    const rows = await rowsOf(a.id);
    // Exactement : une diffusion et un push par destinataire, jamais deux.
    expect(rows.map((row) => `${row.kind}:${row.userId}`).sort()).toEqual(
      ['push:' + bob.id, 'push:' + carol.id, 'socket:'].sort(),
    );

    await Promise.all([dispatcher.deliverMessage(a.id), dispatcher.deliverMessage(b.id)]);
    await waitFor(() => sendsOf(a.id).length === 2);
    await flush();
    expect(emissionsOf(a.id)).toHaveLength(1);
    expect(sendsOf(a.id).map((entry) => entry.userId).sort()).toEqual([bob.id, carol.id].sort());
    expect(await messageCount(alice.id, 'k21')).toBe(1);
  });

  it('garde le contrat de l’événement existant', async () => {
    const alice = await register('Contract');
    const bob = await withPushToken('ContractBob');
    const conversation = await conversations.create(alice.id, [bob.id]);

    const message = await send(conversation.id, alice.id, 'contrat', 'k11');
    await dispatcher.deliverMessage(message.id);

    const [entry] = emissionsOf(message.id);
    const payload = entry.payload;
    expect(entry.event).toBe('message:new');
    // Contrat inchangé : les champs attendus par les clients sont tous là.
    for (const field of ['id', 'conversationId', 'type', 'content', 'sender', 'createdAt']) {
      expect(payload).toHaveProperty(field);
    }
    expect(payload.conversationId).toBe(conversation.id);
    expect(payload.content).toBe('contrat');
    expect(payload.type).toBe('text');
    expect(payload.deleted).toBe(false);
    expect((payload.sender as { id: string }).id).toBe(alice.id);
    // Date sérialisée par Socket.IO, comme avant cette étape.
    expect(payload.createdAt).toBeInstanceOf(Date);
  });
});
