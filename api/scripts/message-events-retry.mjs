#!/usr/bin/env node
/**
 * Reprise administrative des effets secondaires abandonnés (étape 1.2e).
 *
 * Un effet (diffusion `message:new` ou notification) est abandonné après cinq
 * tentatives : il passe en `skipped`, porte sa dernière erreur, et n'est plus
 * repris automatiquement. Ce script le remet en attente **sur la même ligne**
 * — donc sans créer de doublon ni de nouveau message — et le worker de l'API le
 * traite dans les cinq secondes.
 *
 *   node scripts/message-events-retry.mjs                     # état, sans rien changer
 *   node scripts/message-events-retry.mjs --apply              # réarme tout
 *   node scripts/message-events-retry.mjs --message <id> --apply
 *   node scripts/message-events-retry.mjs --kind socket --since 2026-11-01T00:00:00Z --apply
 *
 * Variables : DATABASE_URL (sinon lue dans api/.env).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function databaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  try {
    const env = readFileSync(join(here, '..', '.env'), 'utf8');
    const line = env.split('\n').find((entry) => entry.startsWith('DATABASE_URL='));
    if (line) {
      return line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
    }
  } catch {
    // Pas de .env : on laisse pg utiliser ses variables d'environnement.
  }
  return undefined;
}

function parseArgs(argv) {
  const options = { apply: false, message: null, kind: null, since: null, limit: 500 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--message') {
      options.message = argv[index += 1] ?? null;
    } else if (arg === '--kind') {
      options.kind = argv[index += 1] ?? null;
    } else if (arg === '--since') {
      options.since = argv[index += 1] ?? null;
    } else if (arg === '--limit') {
      options.limit = Number(argv[index += 1] ?? 500);
    } else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`Option inconnue : ${arg}`);
      process.exit(2);
    }
  }
  if (options.kind && !['socket', 'push'].includes(options.kind)) {
    console.error('--kind attend « socket » ou « push »');
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();

const where = ["status = 'skipped'"];
const values = [];
if (options.message) {
  values.push(options.message);
  where.push(`message_id = $${values.length}`);
}
if (options.kind) {
  values.push(options.kind);
  where.push(`kind = $${values.length}`);
}
if (options.since) {
  values.push(options.since);
  where.push(`updated_at >= $${values.length}`);
}
const clause = where.join(' and ');

const summary = await client.query(
  `select kind, count(*)::int as cnt, min(updated_at) as oldest, max(attempts) as attempts
   from message_events where ${clause} group by kind order by kind`,
  values,
);
const total = summary.rows.reduce((sum, row) => sum + row.cnt, 0);
console.log(`Effets abandonnés : ${total}`);
for (const row of summary.rows) {
  console.log(
    `  ${row.kind.padEnd(6)} ${String(row.cnt).padStart(4)}  plus ancien ${row.oldest?.toISOString?.() ?? '—'}  tentatives ${row.attempts}`,
  );
}

const sample = await client.query(
  `select message_id, kind, user_id, attempts, last_error
   from message_events where ${clause} order by updated_at limit 10`,
  values,
);
for (const row of sample.rows) {
  console.log(
    `  · ${row.kind} ${row.message_id.slice(0, 8)} ${row.user_id ? row.user_id.slice(0, 8) : '—'} « ${
      (row.last_error ?? '').slice(0, 80)
    } »`,
  );
}

if (!options.apply) {
  console.log('\nRien n’a été modifié. Relancer avec --apply pour réarmer.');
  await client.end();
  process.exit(0);
}

if (total > options.limit) {
  console.error(
    `\nRefus : ${total} lignes dépassent --limit ${options.limit}. Augmenter la limite en connaissance de cause.`,
  );
  await client.end();
  process.exit(1);
}

const applied = await client.query(
  `update message_events
     set status = 'pending', attempts = 0, last_error = null,
         locked_until = null, claim_token = null, next_attempt_at = now(), updated_at = now()
   where ${clause}
   returning id`,
  values,
);
console.log(`\n${applied.rowCount} effet(s) réarmé(s) sur la même ligne ; le worker les traite.`);
await client.end();
