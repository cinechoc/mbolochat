import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { messageEvents, pushTokens } from '../src/db/schema.js';
import { MessageEventsService } from '../src/message-events/message-events.service.js';

/**
 * Deux invariants de l'étape 1.2e, vérifiés sur la vraie base PostgreSQL :
 *
 * 1. **Unicité réelle du journal** : `(message_id, kind, user_id)` est unique,
 *    y compris pour les événements de diffusion (`user_id = ''`, jamais NULL),
 *    et une valeur NULL est refusée par la base.
 * 2. **Fencing des workers** : un worker dont le bail a expiré ne peut ni
 *    clore, ni reporter, ni libérer la ligne reprise par un autre.
 *
 * Aucun mock de base : on lit `information_schema`, `pg_indexes` et les lignes
 * effectivement écrites.
 */
describe('Journal des effets : unicité et fencing (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let conversations: ConversationsService;
  let events: MessageEventsService;
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
    events = app.get(MessageEventsService);
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
        lastName: 'Fencing',
        email: `${name.toLowerCase()}_fence_${suffix}_${counter}@e2e.dev`,
        password: 'password123',
        birthday: '1995-06-15',
        gender: 'FEMALE',
      })
      .expect(201);
    const id = response.body.user.id as string;
    createdUsers.push(id);
    return { id };
  };

  const setup = async () => {
    const alice = await register('FenceSender');
    const bob = await register('FenceTarget');
    const conversation = await conversations.create(alice.id, [bob.id]);
    counter += 1;
    const message = await conversations.createMessage(
      conversation.id,
      alice.id,
      'fencing',
      undefined,
      `fence-${suffix}-${counter}`,
      undefined,
      null,
      null,
      'text',
      undefined,
      undefined,
    );
    return { alice, bob, conversation, message };
  };

  /**
   * Code SQLSTATE d'une écriture refusée par la base. Drizzle enveloppe
   * l'erreur du pilote : le code est dans la chaîne des `cause`.
   */
  const sqlError = async (query: ReturnType<typeof sql>) => {
    try {
      await db.execute(query);
      return null;
    } catch (error) {
      let current = error as { code?: string; cause?: unknown } | undefined;
      while (current) {
        if (typeof current.code === 'string') {
          return current.code;
        }
        current = current.cause as typeof current;
      }
      return 'inconnu';
    }
  };

  const rowsOf = (messageId: string) => events.listForMessage(messageId);

  describe('contrôle 1 — unicité réelle', () => {
    it('interdit NULL pour user_id : le piège de la contrainte UNIQUE est fermé', async () => {
      const columns = await db.execute<{
        is_nullable: string;
        column_default: string | null;
      }>(sql`
        select is_nullable, column_default
        from information_schema.columns
        where table_name = 'message_events' and column_name = 'user_id'
      `);
      expect(columns.rows).toHaveLength(1);
      expect(columns.rows[0].is_nullable).toBe('NO');
      expect(columns.rows[0].column_default).toContain("''");
    });

    it('a réellement un index unique sur (message_id, kind, user_id)', async () => {
      const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
        select indexname, indexdef from pg_indexes where tablename = 'message_events'
      `);
      const unique = indexes.rows.find((row) => row.indexname === 'message_events_dedupe_idx');
      expect(unique?.indexdef).toContain('UNIQUE');
      expect(unique?.indexdef).toContain('(message_id, kind, user_id)');
    });

    it('rejette un second événement de diffusion du même message', async () => {
      const { message } = await setup();
      // `createMessage` a déjà posé la ligne `socket` : on la rejoue en SQL.
      const code = await sqlError(sql`
        insert into message_events (id, message_id, conversation_id, kind)
        values (gen_random_uuid()::text, ${message.id}, ${message.conversationId}, 'socket')
      `);
      expect(code).toBe('23505');
      expect(
        (await rowsOf(message.id)).filter((row) => row.kind === 'socket'),
      ).toHaveLength(1);
    });

    it('rejette un second envoi vers le même destinataire', async () => {
      const { message, bob } = await setup();
      // La ligne `push` du destinataire existe : même couple, autre identifiant.
      const code = await sqlError(sql`
        insert into message_events (id, message_id, conversation_id, kind, user_id)
        values (gen_random_uuid()::text, ${message.id}, ${message.conversationId}, 'push', ${bob.id})
      `);
      expect(code).toBe('23505');
      const pushRows = (await rowsOf(message.id)).filter((row) => row.kind === 'push');
      expect(pushRows).toHaveLength(1);
    });

    it('refuse une ligne sans destinataire NULL (pas de contournement par NULL)', async () => {
      const { message } = await setup();
      const code = await sqlError(sql`
        insert into message_events (id, message_id, conversation_id, kind, user_id)
        values (gen_random_uuid()::text, ${message.id}, ${message.conversationId}, 'socket', null)
      `);
      expect(code).toBe('23502');
      expect(await sqlError(sql`
        select count(*) from message_events where user_id is null
      `)).toBeNull();
      const nulls = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from message_events where user_id is null
      `);
      expect(nulls.rows[0].n).toBe(0);
      expect((await rowsOf(message.id)).length).toBeGreaterThan(0);
    });

    it('n’ajoute aucune ligne quand enqueue est rejoué', async () => {
      const { alice, bob, message } = await setup();
      const before = await rowsOf(message.id);
      // Rejeu du même enqueue, comme après une reprise.
      await events.enqueue(db, {
        messageId: message.id,
        conversationId: message.conversationId,
        audience: [bob.id],
      });
      const after = await rowsOf(message.id);
      expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
      expect(after.filter((row) => row.kind === 'socket')).toHaveLength(1);
      expect(after.filter((row) => row.kind === 'push')).toHaveLength(1);
      expect(after.some((row) => row.kind === 'push' && row.userId === alice.id)).toBe(false);
    });
  });

  describe('contrôle 2 — fencing des workers', () => {
    /** Expire le bail sans toucher au jeton : le worker croit encore travailler. */
    const expireLease = (id: string) =>
      db
        .update(messageEvents)
        .set({ lockedUntil: new Date(Date.now() - 60_000) })
        .where(eq(messageEvents.id, id));

    const socketRowOf = async (messageId: string) =>
      (await rowsOf(messageId)).filter((row) => row.kind === 'socket')[0];

    it('empêche un worker périmé de clore le travail de son successeur', async () => {
      const { message } = await setup();
      const row = await socketRowOf(message.id);

      // 1. A prend le bail et reçoit son jeton.
      const a = await events.claim(row.id);
      expect(a?.claimToken).toBeTruthy();
      const tokenA = a!.claimToken!;

      // 2. Son bail expire (processus suspendu, machine lente…).
      await expireLease(row.id);

      // 3. B reprend la même ligne : nouveau jeton, propriété transférée.
      const b = await events.claim(row.id);
      expect(b?.claimToken).toBeTruthy();
      const tokenB = b!.claimToken!;
      expect(tokenB).not.toBe(tokenA);

      const reference = await socketRowOf(message.id);
      expect(reference.claimToken).toBe(tokenB);
      expect(reference.attempts).toBe(2);

      // 4 et 5. A tente toutes ses clôtures : aucune ne doit écrire.
      expect(await events.markDone(row.id, tokenA)).toBe(false);
      expect(await events.markSkipped(row.id, tokenA, 'A périmé')).toBe(false);
      expect(await events.release(row.id, tokenA)).toBe(false);
      expect(await events.reschedule(a!, tokenA, 'A périmé')).toBe(false);

      const untouched = await socketRowOf(message.id);
      expect(untouched.status).toBe('pending');
      expect(untouched.claimToken).toBe(tokenB);
      expect(untouched.lockedUntil).toEqual(reference.lockedUntil);
      expect(untouched.lastError).toBeNull();
      expect(untouched.nextAttemptAt).toEqual(reference.nextAttemptAt);
      expect(untouched.attempts).toBe(2);

      // B, lui, clôt normalement.
      expect(await events.markDone(row.id, tokenB)).toBe(true);
      const closed = await socketRowOf(message.id);
      expect(closed.status).toBe('done');
      expect(closed.claimToken).toBeNull();
      expect(closed.lockedUntil).toBeNull();

      // Une clôture tardive d'A après celle de B ne réécrit rien.
      expect(await events.markDone(row.id, tokenA, 'tardif')).toBe(false);
      expect(await events.markSkipped(row.id, tokenA, 'tardif')).toBe(false);
      expect((await socketRowOf(message.id)).status).toBe('done');
      expect((await socketRowOf(message.id)).lastError).toBeNull();
    });

    it('empêche A de reporter une ligne que B détient (pas de double tentative)', async () => {
      const { message } = await setup();
      const row = await socketRowOf(message.id);
      const a = await events.claim(row.id);
      await expireLease(row.id);
      const b = await events.claim(row.id);
      expect(b?.claimToken).toBeTruthy();

      expect(await events.reschedule(a!, a!.claimToken!, 'A en échec')).toBe(false);

      const after = await socketRowOf(message.id);
      // Le report d'A n'a pas rouvert la file : B garde son bail.
      expect(after.claimToken).toBe(b!.claimToken);
      expect(after.lockedUntil).toEqual(b!.lockedUntil);
      expect(after.attempts).toBe(2);
    });

    it('refuse un second bail tant que le premier court', async () => {
      const { message } = await setup();
      const row = await socketRowOf(message.id);
      const a = await events.claim(row.id);
      expect(a).not.toBeNull();

      // Bail encore valide : personne d'autre ne peut prendre la ligne.
      expect(await events.claim(row.id)).toBeNull();
      expect(await events.release(row.id, a!.claimToken!)).toBe(true);
      // Une fois relâchée, la ligne est reprenable — sous un jeton neuf.
      const b = await events.claim(row.id);
      expect(b?.claimToken).toBeTruthy();
      expect(b!.claimToken).not.toBe(a!.claimToken);
      expect(await events.release(row.id, a!.claimToken!)).toBe(false);
    });

    it('réarme un abandon sans conserver le jeton de l’ancienne tentative', async () => {
      const { message } = await setup();
      const row = await socketRowOf(message.id);
      const a = await events.claim(row.id);
      expect(await events.markSkipped(row.id, a!.claimToken!, 'cinq échecs')).toBe(true);

      const skipped = await socketRowOf(message.id);
      expect(skipped.status).toBe('skipped');
      expect(skipped.claimToken).toBeNull();

      expect(await events.retrySkipped({ messageId: message.id })).toBeGreaterThan(0);
      const rearmed = await socketRowOf(message.id);
      expect(rearmed.status).toBe('pending');
      expect(rearmed.attempts).toBe(0);
      expect(rearmed.claimToken).toBeNull();
      expect(rearmed.lastError).toBeNull();
    });
  });
});
