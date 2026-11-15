/**
 * Une coupure réseau ne prouve pas qu'une session est invalide. Seuls les
 * refus explicites du serveur doivent effacer les jetons : sinon une relance
 * hors ligne déconnecte l'utilisateur et masque ses messages pourtant locaux.
 */
export function isTransientSessionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    (status === 0 || status === 408 || status === 429 || status >= 500)
  );
}
