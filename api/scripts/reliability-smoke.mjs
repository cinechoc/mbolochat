/**
 * Vérification de la fiabilité des messages : idempotence à l'envoi, accusés de
 * réception et de lecture, rattrapage après une coupure.
 *
 * L'API doit tourner : `npm run start:dev` (port 3001).
 *   node scripts/reliability-smoke.mjs
 */
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3001';
const suffix = Date.now();

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${text}`);
  }
  return body;
}

/** Appel qui tolère un statut d'erreur : pour vérifier les refus d'accès. */
async function probe(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const register = async (firstName, lastName) => {
  const result = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${suffix}@reliability.dev`,
      password: 'password123',
      birthday: '1995-06-15',
      gender: 'FEMALE',
    }),
  });
  return { ...result, token: result.accessToken };
};

const waitFor = (socket, event, predicate, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, handler);
    };
    const handler = (payload) => {
      if (!predicate || predicate(payload)) {
        cleanup();
        resolve(payload);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout en attendant « ${event} »`));
    }, timeoutMs);
    socket.on(event, handler);
  });

const connect = async (label, token) => {
  const socket = io(API, { auth: { token }, transports: ['websocket'] });
  await waitFor(socket, 'connect', null, 8000);
  console.log(`    (${label} connecté)`);
  return socket;
};

const alice = await register('Ana', 'Relie');
const bob = await register('Ben', 'Relie');
const conversation = await api('/conversations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${alice.token}` },
  body: JSON.stringify({ memberIds: [bob.user.id] }),
});
console.log(`conversation ${conversation.id}`);

let aliceSocket = await connect('Ana', alice.token);
let bobSocket = await connect('Ben', bob.token);
for (const socket of [aliceSocket, bobSocket]) {
  socket.emit('conversation:join', { conversationId: conversation.id });
}

// ————— 1. Un même clientId envoyé deux fois ne produit qu'un seul message.
const clientId = `retry-${suffix}`;
const first = await aliceSocket.timeout(10000).emitWithAck('message:send', {
  conversationId: conversation.id,
  content: 'premier envoi',
  clientId,
});
const replay = await aliceSocket.timeout(10000).emitWithAck('message:send', {
  conversationId: conversation.id,
  content: 'premier envoi',
  clientId,
});
check('répétition après coupure = même message', first.id === replay.id, `${first.id} vs ${replay.id}`);
check('le message porte sa clé d’idempotence', replay.clientId === clientId, String(replay.clientId));

const history = await api(`/conversations/${conversation.id}/messages?limit=100`, {
  headers: { Authorization: `Bearer ${alice.token}` },
});
check(
  "un seul message en base pour ce clientId",
  history.filter((message) => message.clientId === clientId).length === 1,
  `${history.filter((message) => message.clientId === clientId).length} ligne(s)`,
);

// ————— 2. Coche « reçue » : l'appareil destinataire confirme la réception.
const receiptPromise = waitFor(
  aliceSocket,
  'receipt',
  (payload) => payload.receipts?.some((r) => r.messageId === first.id && r.deliveredAt),
);
await bobSocket
  .timeout(10000)
  .emitWithAck('message:ack', { messageIds: [first.id, 'inexistant-qu-on-ignore'] });
const deliveredReceipt = await receiptPromise;
const delivered = deliveredReceipt.receipts.find((r) => r.messageId === first.id);
check('Ana est prévenue que Ben a reçu', Boolean(delivered?.deliveredAt), JSON.stringify(delivered));
check(
  'un id inconnu ne cree pas de faux accuse',
  deliveredReceipt.receipts.every((r) => r.messageId === first.id),
);

// ————— 3. Coche « lue » : la lecture est enregistrée message par message.
const readPromise = waitFor(
  aliceSocket,
  'receipt',
  (payload) => payload.receipts?.some((r) => r.messageId === first.id && r.readAt),
);
bobSocket.emit('message:read', { conversationId: conversation.id });
const readReceipt = await readPromise;
const read = readReceipt.receipts.find((r) => r.messageId === first.id);
check('Ana est prévenue que Ben a lu', Boolean(read?.readAt), JSON.stringify(read));
check('reception conservée en meme temps', Boolean(read?.deliveredAt));

const receipts = await api(`/conversations/${conversation.id}/receipts`, {
  headers: { Authorization: `Bearer ${alice.token}` },
});
const stored = receipts.find((r) => r.messageId === first.id && r.userId === bob.user.id);
check('les accusés sont relisibles par l’expéditeur', Boolean(stored?.readAt), JSON.stringify(stored));

// ————— 4. Rattrapage : Ben coupe, Ana envoie, Ben récupère au retour.
const lastSeenAt = new Date(first.createdAt).toISOString();
bobSocket.disconnect();
await new Promise((resolve) => setTimeout(resolve, 300));
for (const text of ['pendant la coupure 1', 'pendant la coupure 2']) {
  await aliceSocket.timeout(10000).emitWithAck('message:send', {
    conversationId: conversation.id,
    content: text,
  });
}
bobSocket = await connect('Ben (reconnecté)', bob.token);
bobSocket.emit('conversation:join', { conversationId: conversation.id });
const missed = await api(`/conversations/sync?since=${encodeURIComponent(lastSeenAt)}`, {
  headers: { Authorization: `Bearer ${bob.token}` },
});
const missedTexts = missed.map((message) => message.content);
check(
  'le rattrapage rend les messages manqués',
  missedTexts.includes('pendant la coupure 1') && missedTexts.includes('pendant la coupure 2'),
  missedTexts.join(' | '),
);
check(
  'le rattrapage est trié et sans identifiant en double',
  missed.every((m, index) => index === 0 || new Date(m.createdAt) >= new Date(missed[index - 1].createdAt)) &&
    new Set(missed.map((m) => m.id)).size === missed.length,
);
check(
  'le message-curseur peut revenir, une seule fois',
  missedTexts.filter((text) => text === 'premier envoi').length <= 1,
  `${missedTexts.filter((text) => text === 'premier envoi').length} retour(s)`,
);

const afterSync = await api(`/conversations/${conversation.id}/messages?limit=100`, {
  headers: { Authorization: `Bearer ${bob.token}` },
});
check('le rattrapage n’a rien dupliqué', afterSync.length === history.length + 2, `${afterSync.length} vs ${history.length}+2`);

// ————— 5. Un destinataire hors conversation ne peut pas fausser les accusés.
const intru = await register('Ond', 'Hors');
const intruderSocket = await connect('Ond (étranger)', intru.token);
const ackResult = await intruderSocket
  .timeout(10000)
  .emitWithAck('message:ack', { messageIds: [first.id] });
check('un non-membre ne peut accuser réception', ackResult.acked === 0, JSON.stringify(ackResult));
const foreignReceipts = await probe(`/conversations/${conversation.id}/receipts`, intru.token);
check(
  'un non-membre ne peut lire les accusés (403)',
  foreignReceipts.status === 403,
  `statut ${foreignReceipts.status}, ${foreignReceipts.body?.length ?? '-'} accusé(s)`,
);
intruderSocket.disconnect();

// ————— 6. Répondre à un message : la citation voyage avec lui.
const subject = await aliceSocket.timeout(10000).emitWithAck('message:send', {
  conversationId: conversation.id,
  content: 'le sujet d’origine',
  clientId: `reply-subject-${suffix}`,
});
const replyPushed = waitFor(bobSocket, 'message:new', (payload) => payload?.replyTo?.id === subject.id);
const reply = await aliceSocket.timeout(10000).emitWithAck('message:send', {
  conversationId: conversation.id,
  content: 'ma réponse',
  replyToId: subject.id,
  clientId: `reply-${suffix}`,
});
check('l’acquittement porte la citation', reply.replyTo?.id === subject.id, JSON.stringify(reply.replyTo));
check(
  'la citation nomme son auteur',
  reply.replyTo?.senderName === alice.user.displayName,
  String(reply.replyTo?.senderName),
);
check(
  'la citation reprend le texte d’origine',
  reply.replyTo?.content === 'le sujet d’origine',
  String(reply.replyTo?.content),
);
const withQuote = await replyPushed.catch(() => null);
check('le destinataire reçoit la citation', withQuote?.id === reply.id, JSON.stringify(withQuote?.replyTo));

const bogus = await aliceSocket.timeout(10000).emitWithAck('message:send', {
  conversationId: conversation.id,
  content: 'citation hors sol',
  replyToId: '00000000-0000-0000-0000-000000000000',
});
check('citer un message inconnu est refusé', typeof bogus?.error === 'string', JSON.stringify(bogus));

// ————— 7. Retirer un message, pour tous ou pour soi.
const notYours = await bobSocket.timeout(10000).emitWithAck('message:delete', {
  conversationId: conversation.id,
  messageId: subject.id,
  forEveryone: true,
});
check(
  'retirer pour tous est réservé à l’auteur',
  typeof notYours?.error === 'string',
  JSON.stringify(notYours),
);

const seenDelete = waitFor(
  bobSocket,
  'message:deleted',
  (payload) => payload?.messageId === subject.id && payload?.forEveryone === true,
);
const gone = await aliceSocket.timeout(10000).emitWithAck('message:delete', {
  conversationId: conversation.id,
  messageId: subject.id,
  forEveryone: true,
});
check('l’auteur retire bien son message', gone?.deleted === subject.id, JSON.stringify(gone));
const notified = await seenDelete.catch(() => null);
check('les autres appareils sont prévenus', notified?.messageId === subject.id, JSON.stringify(notified));

const afterDelete = await api(`/conversations/${conversation.id}/messages?limit=100`, {
  headers: { Authorization: `Bearer ${bob.token}` },
});
const tombstone = afterDelete.find((message) => message.id === subject.id);
check(
  'le contenu retiré n’est plus en base',
  tombstone?.deleted === true && tombstone?.content === '' && tombstone?.attachment === null,
  JSON.stringify({ deleted: tombstone?.deleted, content: tombstone?.content }),
);
check(
  'la réponse annonce son original retiré',
  afterDelete.find((message) => message.id === reply.id)?.replyTo?.deleted === true,
  JSON.stringify(afterDelete.find((message) => message.id === reply.id)?.replyTo),
);

const hidden = await bobSocket.timeout(10000).emitWithAck('message:delete', {
  conversationId: conversation.id,
  messageId: reply.id,
  forEveryone: false,
});
check('« supprimer pour moi » est accepté au destinataire', hidden?.deleted === reply.id, JSON.stringify(hidden));
const bobView = await api(`/conversations/${conversation.id}/messages?limit=100`, {
  headers: { Authorization: `Bearer ${bob.token}` },
});
const aliceView = await api(`/conversations/${conversation.id}/messages?limit=100`, {
  headers: { Authorization: `Bearer ${alice.token}` },
});
check(
  'le message disparaît de la seule vue de Ben',
  !bobView.some((message) => message.id === reply.id) && aliceView.some((message) => message.id === reply.id),
  `Ben ${bobView.length} message(s), Ana ${aliceView.length}`,
);

// ————— 8. Un message vocal traverse l'import, l'envoi et la relecture.
const upload = async (token, name, mime, fields) => {
  const form = new FormData();
  form.append('file', new File([new TextEncoder().encode('fictif')], name, { type: mime }));
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, String(value));
  }
  const res = await fetch(`${API}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const voiceUpload = await upload(alice.token, 'message.m4a', 'audio/mp4', { duration: 9400 });
check('le vocal est importé', voiceUpload.status === 201, `statut ${voiceUpload.status}`);
check(
  "l'import retient le type canonique et la durée",
  voiceUpload.body?.type === 'AUDIO' && voiceUpload.body?.duration === 9400,
  JSON.stringify({ type: voiceUpload.body?.type, duration: voiceUpload.body?.duration }),
);

const voice = await aliceSocket.timeout(10000).emitWithAck('message:send', {
  conversationId: conversation.id,
  content: '',
  attachmentId: voiceUpload.body.id,
  clientId: `voice-${suffix}`,
});
check('le vocal porte son type jusqu’au message', voice.attachment?.type === 'AUDIO', JSON.stringify(voice.attachment?.type));
check('le vocal porte sa durée jusqu’au message', voice.attachment?.duration === 9400, String(voice.attachment?.duration));
check(
  'la piste du vocal est signée pour être relue',
  typeof voice.attachment?.url === 'string' && voice.attachment.url.startsWith('/media?'),
  String(voice.attachment?.url).slice(0, 32),
);
const playable = await fetch(`${API}${voice.attachment.url}`);
check(
  'la piste se relit en audio/mp4',
  playable.status === 200 && playable.headers.get('content-type') === 'audio/mp4',
  `${playable.status} ${playable.headers.get('content-type')}`,
);

const liar = await upload(alice.token, 'voix.m4a', 'image/jpeg', {});
check(
  'un type déclaré en désaccord avec le fichier est refusé',
  liar.status === 400,
  `statut ${liar.status}`,
);

aliceSocket.disconnect();
bobSocket.disconnect();

console.log(failures === 0 ? '\nTous les contrôles passent.' : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
