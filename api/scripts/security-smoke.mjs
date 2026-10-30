/**
 * Vérification du durcissement : médias plus publics et URLs signées qui
 * expirent, code de réinitialisation qui ne fuit plus, limitation de débit, et
 * jeton push qu'on ne peut pas voler à un autre compte.
 *
 * L'API doit tourner : `npm run start:dev` (port 3001).
 *   node scripts/security-smoke.mjs
 */
import { io } from 'socket.io-client';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const API = process.env.API_URL ?? 'http://localhost:3001';
const suffix = Date.now();

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const register = async (firstName, lastName) => {
  const res = await call('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${suffix}@security.dev`,
      password: 'password123',
      birthday: '1995-06-15',
      gender: 'MALE',
    }),
  });
  if (res.status !== 201) {
    throw new Error(`inscription ${firstName} : ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { ...res.body.user, token: res.body.accessToken };
};

// PNG 1×1, pour avoir un vrai fichier côté serveur.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AABQAB/4EB8V9XHAAAAABJRU5ErkJggg==',
  'base64',
);

const ana = await register('Sigrun', 'Secure');
const ben = await register('Theud', 'Secure');

// ————— 1. Un média importé n'est jamais accessible par son chemin de disque.
const form = new FormData();
form.append('file', new Blob([PNG], { type: 'image/png' }), 'carre.png');
const uploaded = await call('/uploads', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ana.token}` },
  body: form,
});
check('import d’image accepté', uploaded.status === 201, `statut ${uploaded.status}`);
const storedPath = uploaded.body?.url ?? '';
check(
  "la réponse d'import est déjà signée",
  String(storedPath).startsWith('/media?'),
  storedPath.slice(0, 40),
);

const conversation = await call('/conversations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ana.token}` },
  body: JSON.stringify({ memberIds: [ben.id] }),
});
const conversationId = conversation.body.id;

const socket = io(API, { auth: { token: ana.token }, transports: ['websocket'] });
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});
socket.emit('conversation:join', { conversationId });
// L'identifiant stocké est celui de la réponse d'import : le chemin brut reste
// connu du serveur seul, on le retrouve dans la base plus bas.
await socket.timeout(10000).emitWithAck('message:send', {
  conversationId,
  content: '',
  attachmentId: uploaded.body.id,
});

const history = await call(`/conversations/${conversationId}/messages?limit=10`, {
  headers: { Authorization: `Bearer ${ana.token}` },
});
const attachmentUrl = history.body?.[0]?.attachment?.url ?? '';
check('la pièce jointe sort signée', attachmentUrl.startsWith('/media?f=') && attachmentUrl.includes('&s='), attachmentUrl.slice(0, 46));

const granted = await call(attachmentUrl);
check('URL signée lisible', granted.status === 200, `statut ${granted.status}`);
check('type de contenu correct', String(granted.headers.get('content-type') ?? '').startsWith('image/'), granted.headers.get('content-type'));

const tampered = await call(attachmentUrl.replace(/s=[0-9a-f]{6}/, 's=deadbeef'));
check('signature falsifiée refusée', tampered.status === 401, `statut ${tampered.status}`);

const noExpiry = await call(attachmentUrl.replace(/&e=\d+/, ''));
check('expiration manquante refusée', noExpiry.status === 401, `statut ${noExpiry.status}`);

const stolen = attachmentUrl.match(/f=([^&]+)/)?.[1] ? decodeURIComponent(attachmentUrl.match(/f=([^&]+)/)[1]) : storedPath;
const raw = await call(stolen);
check('le chemin de disque n’est plus servi', raw.status === 404, `statut ${raw.status} pour ${stolen}`);

const foreign = await call(attachmentUrl.replace(/f=[^&]+/, `f=${encodeURIComponent('/uploads/0000/00000000-0000-0000-0000-000000000000.png')}`));
check('on ne peut pas signer un autre fichier avec la même URL', foreign.status === 401, `statut ${foreign.status}`);

// ————— 2. Un avatar, qui porte un anti-cache dans son chemin stocké, doit se
// charger quand même : c'est le cas que le PNG seul ne pouvait pas révéler.
const avatarPut = await call('/users/me/avatar', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ana.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: PNG.toString('base64'), mimeType: 'image/jpeg' }),
});
check('avatar enregistré', avatarPut.status === 200 || avatarPut.status === 201, `statut ${avatarPut.status}`);
const me = await call('/auth/me', { headers: { Authorization: `Bearer ${ana.token}` } });
const avatarUrl = me.body?.avatarUrl ?? '';
check("l'avatar porte un anti-cache côté serveur", Boolean(avatarUrl), avatarUrl.slice(0, 46));
const avatarGet = await call(avatarUrl);
check('avatar lisible malgré son anti-cache', avatarGet.status === 200, `statut ${avatarGet.status}`);

// ————— 3. Le code de réinitialisation ne sort plus par la réponse HTTP.
const forgot = await call('/auth/forgot-password', {
  method: 'POST',
  body: JSON.stringify({ emailOrUsername: ana.username }),
});
check('demande de code acceptée', forgot.status === 200, `statut ${forgot.status}`);
check('aucun code renvoyé hors développement', forgot.body?.devCode === undefined, JSON.stringify(forgot.body));

// ————— 4. La route est comptée : on ne peut pas la pomper.
let tooMany = 0;
for (let index = 0; index < 8; index += 1) {
  const again = await call('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ emailOrUsername: ana.username }),
  });
  if (again.status === 429) {
    tooMany += 1;
  }
}
check('limitation de débit sur forgot-password', tooMany > 0, `${tooMany} refus(s) 429 sur 8 rappels`);

// ————— 5. Un jeton push ne change pas de maître.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const deviceToken = `ExpoTokenPartage${suffix}`;
const own = async (userId) =>
  (
    await pool.query('select user_id, token from push_tokens where user_id = $1 and token = $2', [userId, deviceToken])
  ).rows;

await call('/users/me/push-token', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ana.token}` },
  body: JSON.stringify({ token: deviceToken, platform: 'android' }),
});
const afterAna = await own(ana.id);
check('Ana enregistre son appareil', afterAna.length === 1);

await call('/users/me/push-token', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ben.token}` },
  body: JSON.stringify({ token: deviceToken, platform: 'android' }),
});
const stillAna = await own(ana.id);
const afterBen = await own(ben.id);
check("Ben ne peut pas s'approprier le jeton d'Ana", stillAna.length === 1 && stillAna[0].user_id === ana.id);
check('Ben enregistre le sien à côté', afterBen.length === 1);

await call('/users/me/push-token', {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${ben.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: deviceToken }),
});
const surviving = await own(ana.id);
check("la suppression de Ben n'éteint pas Ana", surviving.length === 1 && surviving[0].user_id === ana.id);

await pool.query('delete from push_tokens where token = $1', [deviceToken]);

// ————— 6. Les en-têtes de sécurité sont posés.
const headers = (await call('/auth/me', { headers: { Authorization: `Bearer ${ana.token}` } })).headers;
check('X-Content-Type-Options', headers.get('x-content-type-options') === 'nosniff', String(headers.get('x-content-type-options')));
check('X-Frame-Options', Boolean(headers.get('x-frame-options')), String(headers.get('x-frame-options')));

// ————— 7. Un jeton de rafraîchissement ne fait pas office de jeton d'accès.
const refreshed = await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: 'pas-un-jeton' }) });
check('refresh invalide refusé', refreshed.status === 401, `statut ${refreshed.status}`);
const noType = await call('/auth/me', { headers: { Authorization: 'Bearer abc.def.ghi' } });
check('bearer malformé refusé', noType.status === 401, `statut ${noType.status}`);

// ————— 8. Un groupe ne se pilote que si on en est administrateur.
const carl = await register('Gunde', 'Secure');
const group = await call('/conversations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ana.token}` },
  body: JSON.stringify({ memberIds: [ben.id, carl.id], type: 'GROUP', name: 'Équipe' }),
});
const groupId = group.body?.id;
check('groupe créé', Boolean(groupId), `statut ${group.status}`);
check('le créateur est administrateur', group.body?.myRole === 'admin', String(group.body?.myRole));

const benRenamed = await call(`/conversations/${groupId}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${ben.token}` },
  body: JSON.stringify({ name: 'Détourné' }),
});
check('un membre ne renomme pas le groupe', benRenamed.status === 403, `statut ${benRenamed.status}`);

const dan = await register('Hana', 'Secure');
const benInvites = await call(`/conversations/${groupId}/members`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ben.token}` },
  body: JSON.stringify({ memberIds: [dan.id] }),
});
check('un membre peut ajouter quelqu’un', benInvites.status === 201, `statut ${benInvites.status}`);

const benChangesRole = await call(`/conversations/${groupId}/members/${dan.id}/role`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${ben.token}` },
  body: JSON.stringify({ role: 'admin' }),
});
check('un membre ne change pas les rôles', benChangesRole.status === 403, `statut ${benChangesRole.status}`);

const benCreatesInvite = await call(`/conversations/${groupId}/invites`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ben.token}` },
  body: JSON.stringify({ expiresInHours: 24 }),
});
check('un membre crée un lien d’invitation', benCreatesInvite.status === 201, `statut ${benCreatesInvite.status}`);

const benEvicts = await call(`/conversations/${groupId}/members/${ana.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${ben.token}` },
});
check('un membre n’expulse personne', benEvicts.status === 403, `statut ${benEvicts.status}`);

const anaRenamed = await call(`/conversations/${groupId}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${ana.token}` },
  body: JSON.stringify({ name: 'Équipe pilotée' }),
});
check('l’administrateur renomme', anaRenamed.status === 200 && anaRenamed.body?.name === 'Équipe pilotée', `statut ${anaRenamed.status}`);

const directRenamed = await call(`/conversations/${conversationId}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${ana.token}` },
  body: JSON.stringify({ name: 'Titre imposé' }),
});
check('une discussion directe ne se renomme pas', directRenamed.status === 400, `statut ${directRenamed.status}`);

// Le seul administrateur part : le groupe ne doit pas rester sans pilote.
await call(`/conversations/${groupId}/members/${ana.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${ana.token}` },
});
const promoted = await pool.query(
  'select user_id, role from conversation_members where conversation_id = $1 order by role',
  [groupId],
);
const admins = promoted.rows.filter((row) => row.role === 'admin');
check('il reste un administrateur après le départ du créateur', admins.length === 1, promoted.rows.map((r) => `${r.user_id.slice(0, 4)}:${r.role}`).join(' '));

// Les identifiants TURN ne sortent que pour une session authentifiée.
const iceAnon = await fetch(`${API}/calls/ice-servers`);
check('ICE refusé sans jeton', iceAnon.status === 401, `statut ${iceAnon.status}`);
const iceAuth = await fetch(`${API}/calls/ice-servers`, {
  headers: { Authorization: `Bearer ${ana.token}` },
});
const iceBody = await iceAuth.json();
check(
  'ICE servi avec un jeton',
  iceAuth.status === 200 && Array.isArray(iceBody.servers) && iceBody.servers.length > 0,
  `statut ${iceAuth.status}, ${iceBody.servers?.length ?? 0} serveur(s)`,
);

socket.disconnect();
await pool.end();

console.log(failures === 0 ? '\nTous les contrôles passent.' : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
