/**
 * Politique de téléchargement automatique des médias chiffrés.
 *
 * Rien n'est chargé sans décision : la vignette d'abord, et seulement selon le
 * réglage du réseau courant ; le fichier complet jamais, sauf un toucher
 * explicite. Fonctions pures, pour être vérifiables sans appareil.
 */

export type NetworkClass = 'wifi' | 'cellular' | 'other' | 'offline';

/** Vue minimale de l'état réseau, pour ne dépendre d'aucun module natif ici. */
export interface NetworkSnapshot {
  type?: string | null;
  isConnected?: boolean | null;
}

export function isMetered(network: NetworkClass): boolean {
  // « other » (Ethernet, VPN, inconnu) n'est pas facturé au volume : on le
  // traite comme du Wi-Fi, jamais comme du cellulaire.
  return network === 'cellular';
}

/**
 * Traduit l'état de la plateforme en classe de réseau.
 *
 * Déconnecté ou type absent → hors ligne. Wi-Fi → wifi ; cellulaire (y compris
 * le partage de connexion) → cellular. Tout le reste — Ethernet, VPN, Bluetooth,
 * type inconnu — compte comme « other », donc non facturé au volume.
 */
export function classifyNetwork(state: NetworkSnapshot): NetworkClass {
  if (state.isConnected === false) return 'offline';
  switch (state.type) {
    case 'WIFI':
      return 'wifi';
    case 'CELLULAR':
      return 'cellular';
    case 'NONE':
      return 'offline';
    case undefined:
    case null:
      return state.isConnected ? 'other' : 'offline';
    default:
      return 'other';
  }
}

/** La vignette se charge-t-elle d'office sur ce réseau ? */
export function shouldAutoLoadThumbnail(
  network: NetworkClass,
  prefs: { wifi: boolean; cellular: boolean },
): boolean {
  if (network === 'offline') return false;
  return isMetered(network) ? prefs.cellular : prefs.wifi;
}
