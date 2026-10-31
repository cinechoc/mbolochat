/**
 * Politique vidéo côté client : lecture de l'accusé serveur quand on allume la
 * caméra. Le serveur reste seul juge du plafond ; un accusé muet (vieux
 * serveur, latence) ne doit jamais bloquer l'audio ni la vidéo.
 */
export type VideoToggleVerdict = {
  allowed: boolean;
  /** Refus pour plafond de caméras atteint (message dédié à afficher). */
  capped: boolean;
};

export function interpretVideoToggleAck(ack: unknown): VideoToggleVerdict {
  if (ack && typeof ack === 'object' && typeof (ack as { ok?: unknown }).ok === 'boolean') {
    const reply = ack as { ok: boolean; error?: unknown };
    return {
      allowed: reply.ok,
      capped: !reply.ok && reply.error === 'full',
    };
  }
  return { allowed: true, capped: false };
}
