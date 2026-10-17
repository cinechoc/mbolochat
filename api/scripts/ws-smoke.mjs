import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3000';
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
  headers: { Authorization: `Bearer ${alice.token}` },
  body: JSON.stringify({ memberIds: [bob.user.id] }),
});

const aliceSocket = await connect(alice.token);
const bobSocket = await connect(bob.token);

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
  headers: { Authorization: `Bearer ${bob.token}` },
});
if (history.length < 1) {
  throw new Error('Message was not persisted');
}

aliceSocket.disconnect();
bobSocket.disconnect();
console.log('sent:', sent.id, 'received by bob:', message.content);
console.log('SMOKE TEST OK');
process.exit(0);
