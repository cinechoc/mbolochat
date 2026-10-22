import { api } from './api';
import { drain, settle } from './outbox';
import { getStore } from './store';
import { connectSocket, onConnection, reportDelivered } from './socket';
import type { Message } from './types';

/**
 * Rattrapage et reprise après coupure.
 *
 * Le principe : on se souvient, en millisecondes, du dernier message connu selon
 * l'horloge du SERVEUR. Au retour de connexion, on redemande tout ce qui est
 * arrivé après — c'est comme ça qu'un message envoyé pendant un passage en tunnel
 * finit à l'écran au lieu de se perdre.
 */

type MessagesListener = (messages: Message[]) => void;

const listeners = new Set<MessagesListener>();

/** Les messages récupérés hors écran : la liste et la conversation s'en saisissent. */
export function onMissedMessages(listener: MessagesListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function readCursor(): Promise<number | null> {
  return (await getStore()).readCursor();
}

/**
 * Avance le curseur. Il ne se calcule qu'à partir d'horodatages renvoyés par le
 * serveur : l'heure de l'appareil n'a pas son mot à dire, sinon un téléphone
 * réglé en avance ferait semblant d'avoir déjà tout vu.
 */
export async function advanceCursor(messages: Message[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  let newest = await readCursor();
  for (const message of messages) {
    const at = new Date(message.createdAt).getTime();
    if (!Number.isNaN(at) && (newest === null || at > newest)) {
      newest = at;
    }
  }
  if (newest === null) {
    return;
  }
  (await getStore()).advanceCursor(newest);
}

/** Le message-curseur revient parfois au rattrapage (précision des horodatages) :
 *  la file d'envoi n'a plus rien à faire de celui-là. */
async function settleOwn(messages: Message[], myId: string): Promise<void> {
  for (const message of messages) {
    if (message.sender.id === myId && message.clientId) {
      await settle(message.clientId);
    }
  }
}

let syncing: Promise<Message[]> | null = null;

/** Redemande ce qui est arrivé pendant l'absence. Une seule passe à la fois. */
export function runSync(token: string, myId: string): Promise<Message[]> {
  if (syncing) {
    return syncing;
  }
  syncing = (async () => {
    const cursor = await readCursor();
    // Aucun curseur : on vient d'installer l'app, rien n'a pu manquer.
    if (cursor === null) {
      return [];
    }
    try {
      const missed = await api.syncSince(token, new Date(cursor).toISOString());
      if (missed.length > 0) {
        await settleOwn(missed, myId);
        await advanceCursor(missed);
        const foreign = missed.filter((message) => message.sender.id !== myId).map((message) => message.id);
        reportDelivered(foreign);
        for (const listener of listeners) {
          listener(missed);
        }
      }
      return missed;
    } catch {
      // Pas de réseau : la prochaine connexion réessaiera, le curseur n'a pas
      // bougé, donc rien ne sera oublié.
      return [];
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * Boucle la fiabilité : à chaque retour de connexion, on rattrape ce qui manque
 * et on relance les envois en attente. À démarrer une fois authentifié.
 */
export function startReliability(token: string, myId: string): () => void {
  const unsubscribeConnection = onConnection((connected) => {
    if (!connected) {
      return;
    }
    void runSync(token, myId);
    void drain(token);
  });

  const handleMessage = (message: Message) => {
    void advanceCursor([message]);
    if (message.sender.id === myId) {
      // C'est un message à moi, confirmé côté serveur : la file l'a déjà oublié.
      if (message.clientId) {
        void settle(message.clientId);
      }
      return;
    }
    reportDelivered([message.id]);
  };

  const socket = connectSocket(token);
  socket.on('message:new', handleMessage);

  return () => {
    unsubscribeConnection();
    socket.off('message:new', handleMessage);
  };
}
