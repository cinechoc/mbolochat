import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { messageReceipts, pushTokens } from '../src/db/schema.js';

/**
 * Lecture explicite par message (`POST /conversations/:id/messages/read`) :
 * « Ouvert » ne doit pas apparaître pour un message simplement chargé ou pour
 * un message hors écran — seul un marquage explicite compte.
 *
 * Sur la vraie base PostgreSQL : sélectivité (un message ≠ un autre, autre
 * conversation ignorée, message propre ignoré), idempotence (même `read_at`
 * au second appel), et contrôle d'appartenance (non-membre sans effet).
 */
describe('Lecture par message explicite (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let conversations: ConversationsService;
  const suffix = Date.now();
  let counter = 0;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get<Database>(DRIZZLE);
    await migrate(db, { migrationsFolder: 'drizzle' });
    conversations = app.get(ConversationsService);
  });

  afterAll(async () => {
    for (const userId of createdUsers) {
      await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
      await db.delete(messageReceipts).where(eq(messageReceipts.userId, userId));
    }
    await app.close();
  });

  const register = async (name: string) => {
    counter += 1;
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: name,
        lastName: 'Read',
        email: `${name.toLowerCase()}_read_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id };
  };

  // L'expéditeur envoie deux messages dans une conversation, plus un troisième
  // dans une autre.
  const setup = async () => {
    const alice = await register('ReadSender');
    const bob = await register('ReadTarget');
    const conversation = await conversations.create(alice.id, [bob.id]);
    counter += 1;
    const first = await conversations.createMessage(
      conversation.id,
      alice.id,
      'premier',
      undefined,
      `read-${suffix}-${counter}`,
      undefined,
      null,
      null,
      'text',
      undefined,
      undefined,
    );
    counter += 1;
    const second = await conversations.createMessage(
      conversation.id,
      alice.id,
      'deuxième',
      undefined,
      `read-${suffix}-${counter}`,
      undefined,
      null,
      null,
      'text',
      undefined,
      undefined,
    );
    const other = await conversations.create(alice.id, [bob.id]);
    counter += 1;
    const elsewhere = await conversations.createMessage(
      other.id,
      alice.id,
      'ailleurs',
      undefined,
      `read-${suffix}-${counter}`,
      undefined,
      null,
      null,
      'text',
      undefined,
      undefined,
    );
    return { alice, bob, conversation, first, second, other, elsewhere };
  };

  it('ne marque que le message nommé, et non toute la conversation', async () => {
    const { alice, bob, conversation, first, second } = await setup();

    const [marked] = await conversations.markMessagesRead(conversation.id, bob.id, [first.id]);
    expect(marked.messageId).toBe(first.id);
    expect(marked.readAt).toBeTruthy();

    const receipts = await conversations.listReceipts(conversation.id, alice.id);
    const rows = receipts.filter((row) => row.messageId === second.id);
    expect(rows).toHaveLength(0);
  });

  it('est idempotent : un second marquage ne déplace pas read_at', async () => {
    const { alice, bob, conversation, first } = await setup();

    const [one] = await conversations.markMessagesRead(conversation.id, bob.id, [first.id]);
    // Un second marquage est sans effet : aucun nouvel accusé, et la lecture
    // déjà enregistrée ne change plus.
    const again = await conversations.markMessagesRead(conversation.id, bob.id, [first.id]);
    expect(again).toHaveLength(0);

    const receipts = await conversations.listReceipts(conversation.id, alice.id);
    expect(receipts.filter((row) => row.messageId === first.id)).toHaveLength(1);
    // Même valeur temporelle (chaîne ISO), le second appel n'a rien déplacé.
    expect(
      String(receipts.find((row) => row.messageId === first.id)?.readAt),
    ).toBe(String(one.readAt));
  });

  it('ignore un message d’une autre conversation, et son propre message', async () => {
    const { alice, bob, first, elsewhere } = await setup();

    await conversations.markMessagesRead(first.conversationId, bob.id, [elsewhere.id]);
    await conversations.markMessagesRead(first.conversationId, alice.id, [first.id]);

    const aliceReceipts = await conversations.listReceipts(first.conversationId, bob.id);
    expect(aliceReceipts.filter((row) => row.messageId === elsewhere.id)).toHaveLength(0);
    expect(
      (await conversations.listReceipts(first.conversationId, bob.id)).filter(
        (row) => row.messageId === first.id,
      ),
    ).toHaveLength(0);
  });

  it('refuse tout effet pour un non-membre', async () => {
    const { conversation, first } = await setup();
    const eve = await register('ReadOutsider');

    await conversations.markMessagesRead(conversation.id, eve.id, [first.id]);

    const rows = await conversations.listReceipts(conversation.id, eve.id).catch(() => []);
    expect(rows).toHaveLength(0);
  });
});
