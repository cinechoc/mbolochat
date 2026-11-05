#!/usr/bin/env node
// Client de test E2EE : noyau crypto réel (binaire `peer`, même vodozemac que
// l'app) et mêmes endpoints que l'app. Sert au second participant des
// scénarios d'audit quand un seul appareil physique est pilotable.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3001';
const PEER_BIN = process.env.PEER_BIN ?? new URL(
  '../../crypto/target/release/peer',
  import.meta.url,
).pathname;

const [, , command, ...rest] = process.argv;

function peer(args) {
  return execFileSync(PEER_BIN, args, { encoding: 'utf8' }).trim();
}

async function api(path, { method = 'GET', token, body } = {}) {
  const attempt = async (bearer) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  };
  let res = await attempt(token);
  if (res.status === 401 && token && activeEmail) {
    const state = loadState(activeEmail);
    const auth = await (
      await attemptFresh(state.refreshToken)
    ).json();
    saveState(activeEmail, {
      ...state,
      token: auth.accessToken,
      refreshToken: auth.refreshToken,
    });
    res = await attempt(auth.accessToken);
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

let activeEmail = null;

function attemptFresh(refreshToken) {
  return fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
}

function statePath(email) {
  return `/tmp/e2ee-peer/${email}.state.json`;
}

function loadState(email) {
  activeEmail = email;
  return JSON.parse(readFileSync(statePath(email), 'utf8'));
}

function saveState(email, state) {
  mkdirSync('/tmp/e2ee-peer', { recursive: true });
  writeFileSync(statePath(email), JSON.stringify(state, null, 2));
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const PASSWORD = process.env.PEER_PASSWORD ?? 'password123';

switch (command) {
  // init <email> <prenom> : compte + identité Olm + appareil publié.
  case 'init': {
    const [email, firstName] = rest;
    mkdirSync('/tmp/e2ee-peer', { recursive: true });
    const dir = `/tmp/e2ee-peer/${email}`;
    let auth;
    try {
      auth = await api('/auth/register', {
        method: 'POST',
        body: {
          firstName,
          lastName: 'Peer',
          email,
          password: PASSWORD,
          birthday: '1995-06-15',
          gender: 'FEMALE',
        },
      });
    } catch {
      auth = await api('/auth/login', {
        method: 'POST',
        body: { emailOrUsername: email, password: PASSWORD },
      });
    }
    const bundle = JSON.parse(peer(['init', dir]));
    writeFileSync(`${dir}/bundle.json`, JSON.stringify(bundle));
    const registration = await api('/e2ee/devices', {
      method: 'POST',
      token: auth.accessToken,
      body: {
        identityKey: bundle.identityKey,
        signingKey: bundle.signingKey,
        fallbackPrekey: bundle.fallbackPrekey,
        fallbackPrekeySignature: bundle.fallbackPrekeySignature,
        fallbackPrekeyKeyId: bundle.fallbackPrekeyKeyId,
        oneTimeKeys: bundle.oneTimeKeys,
      },
    });
    saveState(email, {
      userId: auth.user.id,
      email,
      token: auth.accessToken,
      refreshToken: auth.refreshToken,
      deviceId: registration.deviceId,
      dir,
    });
    console.log(
      JSON.stringify({ userId: auth.user.id, deviceId: registration.deviceId }),
    );
    break;
  }

  // identity <email> : clé d'identité publique (pour l'audit des bundles).
  case 'identity': {
    const state = loadState(rest[0]);
    const bundle = JSON.parse(readFileSync(`${state.dir}/bundle.json`, 'utf8'));
    console.log(bundle.identityKey);
    break;
  }

  // send <email> <toUserId> <texte> : session Olm sortante + envoi chiffré.
  case 'send': {
    const [email, toUserId, text] = rest;
    const state = loadState(email);
    const target = await api(`/e2ee/users/${toUserId}/keys?consume=true`, {
      token: state.token,
    });
    writeFileSync(
      `${state.dir}/target.json`,
      JSON.stringify({
        identityKey: target.identityKey,
        oneTimeKey: target.oneTimeKey,
        fallback: target.fallback,
      }),
    );
    const wire = JSON.parse(peer(['send', state.dir, text]));
    const conversations = await api('/conversations', { token: state.token });
    const conversation = conversations.find(
      (item) =>
        item.type === 'DIRECT' && item.members.some((m) => m.id === toUserId),
    );
    if (!conversation) throw new Error(`Conversation directe absente avec ${toUserId}`);
    if (!conversation.e2eeSince) throw new Error('Conversation non basculée en E2EE');
    const socket = await connect(loadState(email).token);
    socket.emit('conversation:join', { conversationId: conversation.id });
    const ack = await socket
      .timeout(15000)
      .emitWithAck('message:send', {
        conversationId: conversation.id,
        content: '',
        encryption: 'v1',
        payload: wire.payload,
        payloadType: wire.payloadType,
        clientId: `peer-${Date.now()}`,
      });
    socket.close();
    console.log(
      JSON.stringify({
        messageId: ack.id,
        conversationId: conversation.id,
        payloadType: wire.payloadType,
        encryption: ack.encryption,
      }),
    );
    break;
  }

  // listen <email> <secondes> [attendu=N] : déchiffre les v1 reçus, sort N textes.
  case 'listen': {
    const [email, seconds, expectedArg] = rest;
    const expected = Number(expectedArg ?? 1);
    let state = loadState(email);
    const conversations = await api('/conversations', { token: state.token });
    state = loadState(email);
    const socket = await connect(state.token);
    for (const conversation of conversations) {
      socket.emit('conversation:join', { conversationId: conversation.id });
    }
    const texts = [];
    const identities = new Map();
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: ${texts.length}/${expected} reçus`)),
        Number(seconds) * 1000,
      );
      socket.on('message:new', async (message) => {
        if (message.encryption !== 'v1' || message.sender.id === state.userId) return;
        try {
          if (!identities.has(message.sender.id)) {
            const bundle = await api(
              `/e2ee/users/${message.sender.id}/keys?consume=false`,
              { token: state.token },
            );
            identities.set(message.sender.id, bundle.identityKey);
          }
          const text = peer([
            'receive',
            state.dir,
            message.payloadType ?? 'normal',
            message.payload,
            identities.get(message.sender.id),
          ]);
          texts.push(text);
          if (texts.length >= expected) {
            clearTimeout(timer);
            resolve();
          }
        } catch (cause) {
          console.error(`receive échoué (${message.id}): ${cause.message.split('\n')[0]}`);
        }
      });
    });
    await done;
    socket.close();
    for (const text of texts) console.log(text);
    break;
  }

  // create-conversation <email> <toUserId> : ouvre le direct (teste la bascule à la création).
  case 'create-conversation': {
    const [email, toUserId] = rest;
    const state = loadState(email);
    const conversation = await api('/conversations', {
      method: 'POST',
      token: state.token,
      body: { memberIds: [toUserId] },
    });
    console.log(
      JSON.stringify({ id: conversation.id, e2eeSince: conversation.e2eeSince }),
    );
    break;
  }

  // plaintext-attempt <email> <conversationId> <texte> : Sc12, le serveur doit refuser.
  case 'plaintext-attempt': {
    const [email, conversationId, text] = rest;
    loadState(email);
    const socket = await connect(loadState(email).token);
    const outcome = await socket
      .timeout(15000)
      .emitWithAck('message:send', { conversationId, content: text })
      .then((ack) =>
        ack && typeof ack === 'object' && 'error' in ack
          ? { accepted: false, error: String(ack.error) }
          : { accepted: true, messageId: ack?.id ?? null },
      )
      .catch((cause) => ({ accepted: false, error: String(cause.message ?? cause) }));
    socket.close();
    console.log(JSON.stringify(outcome));
    break;
  }

  // burst <email> <toUserId> <n> : envoie n messages d'affilée (teste la course de réception).
  case 'burst': {
    const [email, toUserId, countArg] = rest;
    const state = loadState(email);
    const target = await api(`/e2ee/users/${toUserId}/keys?consume=false`, {
      token: state.token,
    });
    if (existsSync(`${state.dir}/session.pickle`) === false) {
      writeFileSync(
        `${state.dir}/target.json`,
        JSON.stringify({
          identityKey: target.identityKey,
          oneTimeKey: target.oneTimeKey,
          fallback: target.fallback,
        }),
      );
    }
    const conversations = await api('/conversations', { token: state.token });
    const conversation = conversations.find(
      (item) =>
        item.type === 'DIRECT' && item.members.some((m) => m.id === toUserId),
    );
    const socket = await connect(loadState(email).token);
    socket.emit('conversation:join', { conversationId: conversation.id });
    for (let index = 0; index < Number(countArg); index += 1) {
      const wire = JSON.parse(peer(['send', state.dir, `rafale-${index + 1}`]));
      await socket
        .timeout(15000)
        .emitWithAck('message:send', {
          conversationId: conversation.id,
          content: '',
          encryption: 'v1',
          payload: wire.payload,
          payloadType: wire.payloadType,
          clientId: `peer-burst-${Date.now()}-${index}`,
        });
    }
    socket.close();
    console.log(JSON.stringify({ sent: Number(countArg), conversationId: conversation.id }));
    break;
  }

  // duplicate <email> <toUserId> : renvoie deux fois la même enveloppe (rejeu).
  case 'duplicate': {
    const [email, toUserId] = rest;
    const state = loadState(email);
    const wire = JSON.parse(peer(['send', state.dir, 'doublon']));
    const conversations = await api('/conversations', { token: state.token });
    const conversation = conversations.find(
      (item) =>
        item.type === 'DIRECT' && item.members.some((m) => m.id === toUserId),
    );
    const socket = await connect(loadState(email).token);
    socket.emit('conversation:join', { conversationId: conversation.id });
    for (const clientId of ['dup-a', 'dup-b']) {
      await socket.timeout(15000).emitWithAck('message:send', {
        conversationId: conversation.id,
        content: '',
        encryption: 'v1',
        payload: wire.payload,
        payloadType: wire.payloadType,
        clientId,
      });
    }
    socket.close();
    console.log(JSON.stringify({ duplicated: true, conversationId: conversation.id }));
    break;
  }

  // history <email> <conversationId> : relit l'historique et déchiffre les v1.
  case 'history': {
    const [email, conversationId] = rest;
    let state = loadState(email);
    const messages = await api(`/conversations/${conversationId}/messages?limit=50`, {
      token: state.token,
    });
    state = loadState(email);
    const identities = new Map();
    const lines = [];
    for (const message of messages) {
      if (message.encryption !== 'v1') continue;
      if (message.sender.id === state.userId) continue;
      if (!identities.has(message.sender.id)) {
        const bundle = await api(
          `/e2ee/users/${message.sender.id}/keys?consume=false`,
          { token: state.token },
        );
        identities.set(message.sender.id, bundle.identityKey);
      }
      try {
        const text = peer([
          'receive',
          state.dir,
          message.payloadType ?? 'normal',
          message.payload,
          identities.get(message.sender.id),
        ]);
        lines.push(`${message.id.slice(0, 8)}: ${text}`);
      } catch (cause) {
        lines.push(`${message.id.slice(0, 8)}: ERREUR ${cause.message.split('\n')[0]}`);
      }
    }
    console.log(lines.join('\n'));
    break;
  }

  default:
    console.error(
      'commandes : init | identity | send | listen | create-conversation | plaintext-attempt | burst | duplicate',
    );
    process.exit(1);
}
