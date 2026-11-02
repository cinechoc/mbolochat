import { describe, expect, it } from 'vitest';

import { classifyNetwork, isMetered, shouldAutoLoadThumbnail } from './mediaPolicy';

describe('politique de téléchargement des médias chiffrés', () => {
  it('ne traite que le cellulaire comme facturé au volume', () => {
    expect(isMetered('cellular')).toBe(true);
    expect(isMetered('wifi')).toBe(false);
    expect(isMetered('other')).toBe(false);
    expect(isMetered('offline')).toBe(false);
  });

  it('classe le réseau annoncé par la plateforme', () => {
    expect(classifyNetwork({ type: 'WIFI', isConnected: true })).toBe('wifi');
    expect(classifyNetwork({ type: 'CELLULAR', isConnected: true })).toBe('cellular');
    expect(classifyNetwork({ type: 'ETHERNET', isConnected: true })).toBe('other');
    expect(classifyNetwork({ type: 'VPN', isConnected: true })).toBe('other');
    expect(classifyNetwork({ type: 'UNKNOWN', isConnected: true })).toBe('other');
  });

  it('traite une connexion absente comme hors ligne', () => {
    expect(classifyNetwork({ type: 'NONE', isConnected: false })).toBe('offline');
    expect(classifyNetwork({ type: 'WIFI', isConnected: false })).toBe('offline');
    expect(classifyNetwork({ type: null, isConnected: null })).toBe('offline');
    expect(classifyNetwork({})).toBe('offline');
  });

  it('ne charge jamais la vignette hors ligne', () => {
    expect(shouldAutoLoadThumbnail('offline', { wifi: true, cellular: true })).toBe(false);
  });

  it('suit le réglage Wi-Fi sur un réseau non facturé', () => {
    expect(shouldAutoLoadThumbnail('wifi', { wifi: true, cellular: false })).toBe(true);
    expect(shouldAutoLoadThumbnail('wifi', { wifi: false, cellular: true })).toBe(false);
    expect(shouldAutoLoadThumbnail('other', { wifi: true, cellular: false })).toBe(true);
  });

  it('suit le réglage données mobiles sur le cellulaire', () => {
    expect(shouldAutoLoadThumbnail('cellular', { wifi: true, cellular: false })).toBe(false);
    expect(shouldAutoLoadThumbnail('cellular', { wifi: false, cellular: true })).toBe(true);
  });
});
