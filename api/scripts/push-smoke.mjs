/**
 * Envoi d'une notification push de test (Expo Push Service) à un utilisateur.
 *
 * Usage :
 *   node scripts/push-smoke.mjs kim.bruneel "Titre" "Corps du message"
 *
 * Prérequis : le compte visé doit avoir enregistré un jeton push
 * (Paramètres › Notifications sur l'app), et le build doit embarquer
 * expo-notifications + les identifiants FCM.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const username = process.argv[2] ?? 'kim.bruneel';
const title = process.argv[3] ?? 'MboloChat';
const body = process.argv[4] ?? 'Notification de test';

const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `select pt.token, u.username
     from push_tokens pt
     join users u on u.id = pt.user_id
    where u.username = $1`,
  [username],
);
await client.end();

if (rows.length === 0) {
  console.error(
    `Aucun jeton push enregistré pour « ${username} ».\n` +
      `Ouvre l'app → Paramètres › Notifications → active les notifications pour enregistrer le jeton.`,
  );
  process.exit(1);
}

console.log(`Envoi à ${rows.length} appareil(s) de « ${username} »…`);

for (const row of rows) {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: row.token,
      sound: 'default',
      title,
      body,
      data: { type: 'test' },
    }),
  });
  const result = await response.json();
  console.log('→', response.status, JSON.stringify(result.data ?? result));
}
