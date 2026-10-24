import type { Socket } from 'socket.io-client';

import { connectSocket, getSocket, onConnection } from '@/lib/socket';
import type { PresenceEntry, PresenceSnapshot } from '@/lib/types';

export type PresenceStatus = 'online' | 'offline' | 'hidden';

export interface PresenceRecord {
  state: PresenceStatus;
  lastSeenAt: string | null;
}

export const HIDDEN_PRESENCE: PresenceRecord = { state: 'hidden', lastSeenAt: null };

const records = new Map<string, PresenceRecord>();
const listeners = new Map<string, Set<() => void>>();
const watched = new Set<string>();
const pendingSubscribe = new Set<string>();
const pendingUnsubscribe = new Set<string>();

let socket: Socket | null = null;
let offConnection: (() => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Écart entre l'horloge du téléphone et celle du serveur, en millisecondes. */
let clockOffsetMs = 0;

function notify(userId: string): void {
  const set = listeners.get(userId);
  if (!set) return;
  for (const listener of set) listener();
}

function setRecord(userId: string, next: PresenceRecord): void {
  const previous = records.get(userId) ?? HIDDEN_PRESENCE;
  if (previous.state === next.state && previous.lastSeenAt === next.lastSeenAt) return;
  records.set(userId, next);
  notify(userId);
}

function applySnapshot(snapshot: PresenceSnapshot): void {
  const serverNow = Date.parse(snapshot.serverNow);
  if (Number.isFinite(serverNow)) {
    clockOffsetMs = Date.now() - serverNow;
  }
  for (const entry of snapshot.presence) {
    applyEntry(entry);
  }
}

function applyEntry(entry: PresenceEntry): void {
  const hasLastSeen = Object.prototype.hasOwnProperty.call(entry, 'lastSeenAt');
  const lastSeenAt = hasLastSeen ? (entry.lastSeenAt ?? null) : null;
  let state: PresenceStatus;
  if (entry.online === true) {
    state = 'online';
  } else if (entry.online === false || hasLastSeen) {
    state = 'offline';
  } else {
    state = 'hidden';
  }
  setRecord(entry.userId, { state, lastSeenAt });
}

function handlePresenceUpdate(snapshot: PresenceSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.presence)) return;
  applySnapshot(snapshot);
}

function flushSubscriptions(): void {
  flushTimer = null;
  const current = getSocket();
  if (!current?.connected) {
    // Le prochain onConnection réabonnera l'ensemble des utilisateurs suivis.
    pendingSubscribe.clear();
    pendingUnsubscribe.clear();
    return;
  }
  const subscribe = [...pendingSubscribe].filter((id) => watched.has(id)).slice(0, 50);
  const unsubscribe = [...pendingUnsubscribe].filter((id) => !watched.has(id));
  pendingSubscribe.clear();
  pendingUnsubscribe.clear();
  if (subscribe.length > 0) {
    current.emit('presence:subscribe', { userIds: subscribe });
  }
  if (unsubscribe.length > 0) {
    current.emit('presence:unsubscribe', { userIds: unsubscribe });
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flushSubscriptions, 30);
}

function emitSubscriptionsForAll(): void {
  const current = getSocket();
  if (!current?.connected) return;
  const ids = [...watched].slice(0, 50);
  if (ids.length > 0) {
    current.emit('presence:subscribe', { userIds: ids });
  }
}

/** Configure le socket qui portera les abonnements de présence. */
export function configurePresence(token: string): void {
  const next = connectSocket(token);
  if (socket === next) return;
  socket?.off('presence:update', handlePresenceUpdate);
  offConnection?.();
  socket = next;
  socket.on('presence:update', handlePresenceUpdate);
  // Un changement de session peut avoir vidé la liste sans démonter les hooks.
  for (const userId of listeners.keys()) watched.add(userId);
  offConnection = onConnection((connected) => {
    if (connected) emitSubscriptionsForAll();
  });
}

/** Abonnement partagé : plusieurs composants sur le même utilisateur = un seul socket. */
export function subscribePresenceUser(userId: string, listener: () => void): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  if (set.size === 1) {
    watched.add(userId);
    pendingUnsubscribe.delete(userId);
    pendingSubscribe.add(userId);
    scheduleFlush();
  }
  return () => {
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size > 0) return;
    listeners.delete(userId);
    watched.delete(userId);
    pendingSubscribe.delete(userId);
    pendingUnsubscribe.add(userId);
    scheduleFlush();
  };
}

export function getPresenceRecord(userId: string): PresenceRecord {
  return records.get(userId) ?? HIDDEN_PRESENCE;
}

/** Horloge corrigée par le dernier `serverNow` reçu. */
export function presenceNow(): Date {
  return new Date(Date.now() - clockOffsetMs);
}

/**
 * Déconnexion : prévenir le serveur avant que le socket ne soit fermé. Un
 * acquittement court suffit ; sinon le grace serveur prend le relais.
 */
export async function announcePresenceLogout(): Promise<void> {
  const current = getSocket();
  if (!current?.connected) return;
  try {
    await Promise.race([
      current.timeout(500).emitWithAck('presence:logout'),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch {
    // Le grace de déconnexion serveur prendra le relais.
  }
}

/** À appeler à la déconnexion : aucune présence de l'ancien compte ne doit rester. */
export function resetPresence(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  socket?.off('presence:update', handlePresenceUpdate);
  offConnection?.();
  socket = null;
  offConnection = null;
  watched.clear();
  pendingSubscribe.clear();
  pendingUnsubscribe.clear();
  records.clear();
  clockOffsetMs = 0;
  for (const set of listeners.values()) {
    for (const listener of set) listener();
  }
}
