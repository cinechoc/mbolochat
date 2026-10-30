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

const alice = await register('Alice', 'Smoke');
const bob = await register('Bob', 'Smoke');

const conversation = await api('/conversations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${alice.accessToken}` },
  body: JSON.stringify({ memberIds: [bob.user.id] }),
});

const aliceSocket = await connect(alice.accessToken);
const bobSocket = await connect(bob.accessToken);

aliceSocket.emit('conversation:join', { conversationId: conversation.id });
bobSocket.emit('conversation:join', { conversationId: conversation.id });

const received = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timeout waiting for message:new')), 5000);
  bobSocket.on('message:new', (message) => {
    clearTimeout(timeout);
    resolve(message);
  });
});

await new Promise((resolve) => setTimeout(resolve, 300));

const sent = await aliceSocket.emitWithAck('message:send', {
  conversationId: conversation.id,
  content: 'Bonjour Bob !',
});
const message = await received;

if (message.content !== 'Bonjour Bob !' || message.sender.username !== alice.user.username) {
  throw new Error(`Unexpected message received: ${JSON.stringify(message)}`);
}

const history = await api(`/conversations/${conversation.id}/messages`, {
  headers: { Authorization: `Bearer ${bob.accessToken}` },
});
if (history.length < 1) {
  throw new Error('Message was not persisted');
}

// typing indicator
const typingReceived = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timeout waiting for typing')), 5000);
  bobSocket.on('typing', (payload) => {
    clearTimeout(timeout);
    resolve(payload);
  });
});
aliceSocket.emit('typing', { conversationId: conversation.id, text: 'Salut' });
const typing = await typingReceived;
if (typing.userId !== alice.user.id || typing.text !== 'Salut') {
  throw new Error(`Unexpected typing payload: ${JSON.stringify(typing)}`);
}

// read receipts
const readReceived = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timeout waiting for read')), 5000);
  aliceSocket.on('read', (payload) => {
    clearTimeout(timeout);
    resolve(payload);
  });
});
bobSocket.emit('message:read', { conversationId: conversation.id });
const read = await readReceived;
if (read.userId !== bob.user.id) {
  throw new Error(`Unexpected read payload: ${JSON.stringify(read)}`);
}

// refresh token rotation
const refreshed = await api('/auth/refresh', {
  method: 'POST',
  body: JSON.stringify({ refreshToken: alice.refreshToken }),
});
if (!refreshed.accessToken || !refreshed.refreshToken) {
  throw new Error('Refresh did not return new tokens');
}
const reuse = await fetch(`${API}/auth/refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken: alice.refreshToken }),
});
if (reuse.ok) {
  throw new Error('Rotated refresh token should be rejected');
}

// ————— réactions emoji : diffusées à tout le salon.
const reactionReceived = new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('timeout waiting for message:reaction')),
    5000,
  );
  bobSocket.once('message:reaction', (payload) => {
    clearTimeout(timeout);
    resolve(payload);
  });
});
await aliceSocket.emitWithAck('message:react', {
  conversationId: conversation.id,
  messageId: message.id,
  reaction: 'mbolo-panther-2d/fou-rire',
});
const reaction = await reactionReceived;
if (
  reaction.reactions?.[0]?.reaction !== 'mbolo-panther-2d/fou-rire' ||
  reaction.reactions[0].count !== 1
) {
  throw new Error(`Unexpected reaction payload: ${JSON.stringify(reaction)}`);
}

// ————— événements de groupe : identité, ajout, éviction du salon.
const carol = await register('Carol', 'Smoke');
const group = await api('/conversations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${alice.accessToken}` },
  body: JSON.stringify({ type: 'GROUP', name: 'Équipe', memberIds: [bob.user.id] }),
});

const waitFor = (socket, event, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const carolSocket = await connect(carol.accessToken);

const groupUpdated = waitFor(bobSocket, 'group:updated');
await api(`/conversations/${group.id}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${alice.accessToken}` },
  body: JSON.stringify({ name: 'Équipe renommée', emoji: '🚀' }),
});
const updated = await groupUpdated;
if (updated.group?.name !== 'Équipe renommée' || updated.group?.emoji !== '🚀') {
  throw new Error(`Unexpected group:updated payload: ${JSON.stringify(updated)}`);
}

const membersChanged = waitFor(carolSocket, 'members:changed');
await api(`/conversations/${group.id}/members`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${bob.accessToken}` },
  body: JSON.stringify({ memberIds: [carol.user.id] }),
});
const change = await membersChanged;
if (change.action !== 'added' || !change.userIds?.includes(carol.user.id)) {
  throw new Error(`Unexpected members:changed payload: ${JSON.stringify(change)}`);
}

carolSocket.emit('conversation:join', { conversationId: group.id });
await new Promise((resolve) => setTimeout(resolve, 200));

const removed = waitFor(carolSocket, 'conversation:removed');
const eviction = await fetch(`${API}/conversations/${group.id}/members/${carol.user.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${alice.accessToken}` },
});
if (!eviction.ok) {
  throw new Error(`eviction -> ${eviction.status} ${await eviction.text()}`);
}
const removal = await removed;
if (removal.conversationId !== group.id) {
  throw new Error(`Unexpected conversation:removed payload: ${JSON.stringify(removal)}`);
}
carolSocket.disconnect();

aliceSocket.disconnect();
bobSocket.disconnect();
console.log('sent:', sent.id, 'received by bob:', message.content);
console.log('typing ok, read ok, refresh rotation ok, group events ok');
console.log('SMOKE TEST OK');
process.exit(0);
