import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3001';
const suffix = Date.now();

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function register(firstName, lastName) {
  return api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}_${suffix}@smoke.dev`,
      password: 'password123',
      birthday: '1995-06-15',
      gender: 'FEMALE',
    }),
  });
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function once(socket, event, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), timeoutMs);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

const alice = await register('Alice', 'Call');
const bob = await register('Bob', 'Call');
const carol = await register('Carol', 'Call');

const group = await api('/conversations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${alice.accessToken}` },
  body: JSON.stringify({ type: 'GROUP', name: 'Appel smoke', memberIds: [bob.user.id, carol.user.id] }),
});

const [aliceSocket, bobSocket, carolSocket] = await Promise.all([
  connect(alice.accessToken),
  connect(bob.accessToken),
  connect(carol.accessToken),
]);

const started = emitAck(aliceSocket, 'gcall:start', {
  conversationId: group.id,
  media: 'AUDIO',
});
const invite = once(bobSocket, 'gcall:incoming');
const ack = await started;
if (!ack.ok) {
  throw new Error(`gcall:start refusé : ${ack.error}`);
}
console.log('appel ouvert', ack.callId, '· plafond', ack.maxParticipants, '·', ack.media);
if (ack.maxParticipants !== 8) {
  throw new Error(`plafond audio inattendu : ${ack.maxParticipants}`);
}

const incoming = await invite;
if (incoming.callId !== ack.callId || incoming.name !== 'Appel smoke') {
  throw new Error('invitation mal formée');
}
console.log('invitation reçue par Bob ·', incoming.from.displayName);

// Bob rejoint : Alice doit être prévenue de son arrivée.
const joinedOnAlice = once(aliceSocket, 'gcall:joined');
const bobAck = await emitAck(bobSocket, 'gcall:start', { conversationId: group.id });
if (!bobAck.ok || bobAck.members.length !== 2) {
  throw new Error(`rejoint refusé : ${JSON.stringify(bobAck)}`);
}
const joined = await joinedOnAlice;
if (joined.peer.id !== bob.user.id) {
  throw new Error('mauvais pair annoncé');
}
console.log('Alice prévenue de l’arrivée de Bob');

// Signalisation relayée d'un pair à l'autre.
const offerOnBob = once(bobSocket, 'gcall:offer');
await emitAck(aliceSocket, 'gcall:offer', { callId: ack.callId, to: bob.user.id, sdp: 'v=0 smoke' });
const offered = await offerOnBob;
if (offered.sdp !== 'v=0 smoke' || offered.from !== alice.user.id) {
  throw new Error('offer mal relayée');
}
console.log('offer relayée Alice → Bob');

// Le micro coupé est signalé aux autres, pas à soi.
const muteOnAlice = once(aliceSocket, 'gcall:mute');
bobSocket.emit('gcall:mute', { callId: ack.callId, muted: true });
console.log('micro de Bob coupé, signalé à Alice :', (await muteOnAlice).muted);

// Un non-participant ne peut pas relayer.
const relayOutsider = await emitAck(carolSocket, 'gcall:offer', {
  callId: ack.callId,
  to: bob.user.id,
  sdp: 'v=0',
});
if (relayOutsider.ok) {
  throw new Error('signalisation acceptée depuis un non-participant');
}
console.log('signalisation d’un non-participant refusée');

// Carol refuse d'abord, puis est relancé volontairement depuis l'écran d'appel.
await emitAck(carolSocket, 'gcall:decline', { callId: ack.callId });
const ringingAgain = once(carolSocket, 'gcall:incoming', 8_000);
await emitAck(aliceSocket, 'gcall:add', { callId: ack.callId, userIds: [carol.user.id] });
await ringingAgain;
console.log('refus de Carol, puis relancé par « Ajouter »');

const carolAck = await emitAck(carolSocket, 'gcall:start', { conversationId: group.id });
if (!carolAck.ok || carolAck.members.length !== 3) {
  throw new Error(`Carol n’a pas rejoint : ${JSON.stringify(carolAck)}`);
}
console.log('Carol a rejoint (3 participants)');

// Bascule vidéo : acceptée tant que le plafond vidéo n'est pas atteint.
const media = await emitAck(aliceSocket, 'gcall:media', { callId: ack.callId, media: 'VIDEO' });
if (!media.ok) {
  throw new Error(`bascule vidéo refusée : ${JSON.stringify(media)}`);
}
console.log('appel passé en vidéo');

// Seul un administrateur peut sortir quelqu'un de l'appel.
const wrongKick = await emitAck(carolSocket, 'gcall:kick', {
  callId: ack.callId,
  userId: bob.user.id,
});
if (wrongKick.ok) {
  throw new Error('un simple membre a pu exclure un participant');
}
const kickedNotice = once(bobSocket, 'gcall:kicked');
const adminKick = await emitAck(aliceSocket, 'gcall:kick', {
  callId: ack.callId,
  userId: bob.user.id,
});
if (!adminKick.ok) {
  throw new Error(`l'administrateur n'a pas pu exclure : ${JSON.stringify(adminKick)}`);
}
await kickedNotice;
console.log('Bob exclu par l’administrateur, l’appel continue');

// Le dernier parti ferme l'appel et laisse la durée dans la conversation.
await new Promise((resolve) => setTimeout(resolve, 1_300));
const endedNotice = once(aliceSocket, 'gcall:ended', 8_000);
carolSocket.emit('gcall:leave', { callId: ack.callId });
aliceSocket.emit('gcall:leave', { callId: ack.callId });
await endedNotice;
await new Promise((resolve) => setTimeout(resolve, 500));
console.log('appel fermé, bandeaux éteints chez les membres');

const history = await api(`/conversations/${group.id}/messages?limit=50`, {
  headers: { Authorization: `Bearer ${alice.accessToken}` },
});
const system = history.filter((item) => item.type === 'system').map((item) => item.content);
console.log('messages système :', system);
if (!system.some((content) => content.startsWith('Appel de groupe en cours'))) {
  throw new Error('message système d’appel manquant');
}
if (!system.some((content) => content.startsWith('Appel terminé ·'))) {
  throw new Error(`durée finale absente : ${JSON.stringify(system)}`);
}

for (const socket of [aliceSocket, bobSocket, carolSocket]) {
  socket.close();
}
console.log('\nOK — signalisation d’appel de groupe');
