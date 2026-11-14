/**
 * Réinjecte un envoi refusé dans la saisie sans écraser ce que l'utilisateur
 * a commencé à retaper pendant la requête.
 */
export function restoreFailedText(current: string, failed: string): string {
  if (!current.trim()) {
    return failed;
  }
  return `${current}\n${failed}`;
}
