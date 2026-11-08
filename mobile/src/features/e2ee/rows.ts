import { CHAT_TIME_GAP_MS } from '@/constants/chat-timing';
import { formatClock, formatDateLabel } from '@/lib/format';
import type { StoredE2eeMessage } from './db';

/**
 * Mise en page de la liste des messages chiffrés.
 *
 * Même grammaire que la conversation claire : séparateur de date à chaque
 * journée, heure rappelée après une pause, et messages consécutifs du même
 * expéditeur regroupés (un seul avatar). Pure et sans état : testable sans
 * React Native.
 */
export type E2eeListRow =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'time'; label: string }
  | { key: string; type: 'message'; message: StoredE2eeMessage; continuation: boolean };

/** Horodatage local d'un message stocké, tolérant à une valeur illisible. */
function timeOf(message: StoredE2eeMessage): number {
  const parsed = Date.parse(message.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildMessageRows(messages: StoredE2eeMessage[]): E2eeListRow[] {
  const rows: E2eeListRow[] = [];
  let lastLabel = '';
  let lastMs: number | null = null;
  let lastSender: string | null = null;

  for (const message of messages) {
    const ms = timeOf(message);
    const iso = new Date(ms).toISOString();
    const label = formatDateLabel(iso);
    const sender = message.mine === 1 ? 'me' : 'peer';

    if (label !== lastLabel) {
      rows.push({ key: `date-${message.id}`, type: 'date', label });
      lastLabel = label;
      lastMs = null;
      lastSender = null;
    } else if (lastMs !== null && ms - lastMs > CHAT_TIME_GAP_MS) {
      rows.push({ key: `time-${message.id}`, type: 'time', label: formatClock(iso) });
    }

    const continuation =
      lastSender === sender && lastMs !== null && ms - lastMs <= CHAT_TIME_GAP_MS;
    rows.push({ key: message.id, type: 'message', message, continuation });
    lastMs = ms;
    lastSender = sender;
  }

  return rows;
}
