#!/usr/bin/env node
/**
 * Simulation de développement d'un second utilisateur (non livré dans l'app).
 *
 * Depuis api/ :
 *   node scripts/presence-sim.mjs --email moi2@example.com --password 'MotDePasse1!'
 *   node scripts/presence-sim.mjs --register --with kim.bruneel
 *
 * Commandes une fois connecté :
 *   f  premier plan / en ligne      b  arrière-plan
 *   h  battement immédiat           x  coupure réseau brutale (grace 10 s)
 *   q  déconnexion propre
 *
 * --with <username> crée une conversation directe avec le compte principal si
 * elle n'existe pas. --register crée un compte de test (mot de passe par défaut
 * Presence123! si --password est absent).
 */
import 'dotenv/config';
import readline from 'node:readline';
import { io } from 'socket.io-client';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const API = (process.env.SIM_API_URL ?? valueOf('api') ?? 'http://localhost:3001').replace(/\/+$/, '');
const stamp = Date.now().toString(36);

/** Garde-fou : ce script de développement ne doit jamais toucher un serveur distant. */
function assertLocal(label, raw, protocols) {
  if (!raw) {
    console.error(`Refus : ${label} URL absente. Utilise une adresse locale (localhost).`);
    process.exit(1);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`Refus : ${label} URL invalide (${raw}).`);
    process.exit(1);
  }
  if (protocols && !protocols.includes(url.protocol)) {
    console.error(`Refus : ${label} doit utiliser ${protocols.join(' ou ')}.`);
    process.exit(1);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!loopback) {
    console.error(
      `Refus : ${label} n'est pas local (${host}). Ce script refuse toute adresse non locale.`,
    );
    process.exit(1);
  }
}

assertLocal('API', API, ['http:', 'https:']);
assertLocal('base de données', process.env.DATABASE_URL);
const email = process.env.SIM_EMAIL ?? valueOf('email') ?? `presence.sim.${stamp}@example.com`;
const password = process.env.SIM_PASSWORD ?? valueOf('password') ?? 'Presence123!';
const register = has('register') || !valueOf('email');
const withUsername = valueOf('with');

async function call(path, token, method = 'GET', body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = data?.message ?? `HTTP ${response.status}`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return data;
}

async function authenticate() {
  if (register) {
    try {
      const result = await call('/auth/register', null, 'POST', {
        firstName: 'Presence',
        lastName: `Sim${stamp.slice(-4)}`,
        email,
        password,
        birthday: '1995-01-01',
        gender: 'CUSTOM',
      });
      console.log(`Compte simulé créé : ${result.user.displayName} (${email})`);
      return result;
    } catch (error) {
      if (!has('register')) {
        console.log(`Création impossible (${error.message}), tentative de connexion…`);
      } else {
        throw error;
      }
    }
  }
  const result = await call('/auth/login', null, 'POST', {
    emailOrUsername: email,
    password,
  });
  console.log(`Connecté en tant que ${result.user.displayName} (@${result.user.username})`);
  return result;
}

async function ensureConversation(token, userId) {
  if (!withUsername) return;
  const results = await call(`/users/search?q=${encodeURIComponent(withUsername)}`, token);
  const target =
    results.find((user) => user.username === withUsername) ??
    results.find((user) => user.displayName === withUsername) ??
    results[0];
  if (!target) {
    console.log(`Aucun utilisateur trouvé pour « ${withUsername} ».`);
    return;
  }
  const conversations = await call('/conversations', token);
  const exists = conversations.some(
    (conversation) =>
      conversation.type === 'DIRECT' &&
      conversation.members.some((member) => member.id === target.id),
  );
  if (!exists) {
    await call('/conversations', token, 'POST', {
      type: 'DIRECT',
      memberIds: [target.id],
    });
    console.log(`Conversation directe créée avec ${target.displayName}.`);
  } else {
    console.log(`Conversation directe déjà présente avec ${target.displayName}.`);
  }
}

const auth = await authenticate();
const token = auth.accessToken;
await ensureConversation(token, auth.user.id);

const socket = io(API, {
  auth: { token },
  transports: ['websocket', 'polling'],
});
let heartbeat = null;
let alive = true;

function startHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    if (socket.connected) socket.emit('presence:heartbeat');
  }, 25_000);
  heartbeat.unref?.();
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

socket.on('connect', () => {
  socket.emit('presence:foreground');
  startHeartbeat();
  console.log('SOCKET CONNECTÉ — en ligne. Commandes : f b h x q');
});

socket.on('disconnect', () => {
  stopHeartbeat();
  if (alive) console.log('Socket déconnecté (le serveur appliquera son grace).');
});

socket.on('connect_error', (error) => {
  console.log(`Connexion impossible : ${error.message}`);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => {
  if (alive) rl.setPrompt('presence> ');
  if (alive) rl.prompt();
};
rl.on('line', (raw) => {
  const command = raw.trim().toLowerCase();
  if (command === 'f' || command === 'foreground') {
    socket.emit('presence:foreground');
    startHeartbeat();
    console.log('→ premier plan (en ligne)');
  } else if (command === 'b' || command === 'background') {
    stopHeartbeat();
    socket.emit('presence:background');
    console.log('→ arrière-plan');
  } else if (command === 'h' || command === 'heartbeat') {
    socket.emit('presence:heartbeat');
    console.log('→ battement envoyé');
  } else if (command === 'x' || command === 'cut') {
    console.log('→ coupure brutale ; fermeture immédiate du socket.');
    alive = false;
    stopHeartbeat();
    rl.close();
    socket.io.engine.close();
    process.exit(0);
  } else if (command === 'q' || command === 'quit') {
    alive = false;
    stopHeartbeat();
    rl.close();
    if (socket.connected) {
      socket.emit('presence:logout');
    }
    setTimeout(() => {
      socket.disconnect();
      process.exit(0);
    }, 150);
  } else if (command) {
    console.log('Commandes : f (premier plan), b (arrière-plan), h (battement), x (coupure), q (quitter).');
  }
  prompt();
});

prompt();
process.on('SIGINT', () => {
  rl.close();
  process.exit(0);
});
