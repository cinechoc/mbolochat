import { describe, expect, it, vi } from 'vitest';

import {
  getStoredTranscription,
  getVoiceTranscriber,
  MAX_TRANSCRIPTION_LENGTH,
  normalizeTranscription,
  setVoiceTranscriber,
  storeTranscription,
  transcribeVoiceMessage,
  voiceTranscriptionAvailable,
  type VoiceTranscriber,
} from './transcription';

/** Cache en mémoire : ne connaît que le couple (message_id, text). */
function fakeDb() {
  const rows = new Map<string, string>();
  return {
    rows,
    async getFirstAsync<T>(sql: string, ...params: unknown[]) {
      void sql;
      const key = params[0] as string;
      return (rows.has(key) ? { text: rows.get(key) } : null) as T | null;
    },
    async runAsync(sql: string, ...params: unknown[]) {
      void sql;
      rows.set(params[0] as string, params[1] as string);
      return { changes: 1 };
    },
  };
}

describe('registre du moteur de transcription', () => {
  it('aucun moteur par défaut : le bouton « Aa » reste masqué', () => {
    setVoiceTranscriber(null);
    expect(getVoiceTranscriber()).toBeNull();
    expect(voiceTranscriptionAvailable()).toBe(false);
  });

  it('un moteur enregistré rend la transcription disponible, puis se retire', () => {
    setVoiceTranscriber(null);
    const engine: VoiceTranscriber = { transcribe: async () => 'bonjour' };
    setVoiceTranscriber(engine);
    expect(getVoiceTranscriber()).toBe(engine);
    expect(voiceTranscriptionAvailable()).toBe(true);
    setVoiceTranscriber(null);
    expect(voiceTranscriptionAvailable()).toBe(false);
  });
});

describe('normalizeTranscription', () => {
  it('renvoie null pour un transcript vide ou blanc', () => {
    expect(normalizeTranscription(null)).toBeNull();
    expect(normalizeTranscription(undefined)).toBeNull();
    expect(normalizeTranscription('')).toBeNull();
    expect(normalizeTranscription('   \n  ')).toBeNull();
  });

  it('coupe les espaces superflus autour du texte', () => {
    expect(normalizeTranscription('  bonjour à tous  ')).toBe('bonjour à tous');
  });

  it('borne un transcript démesuré avec une ellipse', () => {
    const long = 'a'.repeat(MAX_TRANSCRIPTION_LENGTH + 500);
    const text = normalizeTranscription(long);
    expect(text).not.toBeNull();
    expect(text?.length).toBe(MAX_TRANSCRIPTION_LENGTH + 1);
    expect(text?.endsWith('…')).toBe(true);
  });
});

describe('cache et orchestration du bouton « Aa »', () => {
  it('sans moteur ni cache, la transcription reste indisponible', async () => {
    setVoiceTranscriber(null);
    const db = fakeDb();
    await expect(
      transcribeVoiceMessage(db, 'm1', { uri: 'file:///a.m4a', mimeType: 'audio/mp4', durationMs: 900 }),
    ).resolves.toBeNull();
    expect(db.rows.size).toBe(0);
  });

  it('un transcript en cache est relu sans rappeler le moteur', async () => {
    const db = fakeDb();
    await storeTranscription(db, 'm1', 'texte déjà transcrit');
    const engine = vi.fn(async () => 'jamais appelé');
    setVoiceTranscriber({ transcribe: engine });
    await expect(
      transcribeVoiceMessage(db, 'm1', { uri: 'file:///a.m4a', mimeType: 'audio/mp4', durationMs: 900 }),
    ).resolves.toBe('texte déjà transcrit');
    expect(engine).not.toHaveBeenCalled();
    setVoiceTranscriber(null);
  });

  it('le moteur produit, le texte est normalisé puis mis en cache', async () => {
    const db = fakeDb();
    setVoiceTranscriber({ transcribe: async () => '  voici le texte  ' });
    await expect(
      transcribeVoiceMessage(db, 'm2', { uri: 'file:///b.m4a', mimeType: 'audio/mp4', durationMs: 1200 }),
    ).resolves.toBe('voici le texte');
    await expect(getStoredTranscription(db, 'm2')).resolves.toBe('voici le texte');
    setVoiceTranscriber(null);
  });

  it('un audio sans parole ne stocke rien', async () => {
    const db = fakeDb();
    setVoiceTranscriber({ transcribe: async () => '   ' });
    await expect(
      transcribeVoiceMessage(db, 'm3', { uri: 'file:///c.m4a', mimeType: 'audio/mp4', durationMs: 800 }),
    ).resolves.toBeNull();
    expect(db.rows.size).toBe(0);
    setVoiceTranscriber(null);
  });
});
