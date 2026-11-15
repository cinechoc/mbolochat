/**
 * Le chiffrement est actif par défaut : seule une désactivation explicite
 * (`false`, `0`, `off`, `no`) le coupe. Un serveur sans variable E2EE ne doit
 * pas laisser croire aux clients que les nouvelles conversations peuvent rester
 * en clair.
 */
export function isE2eeEnabled(
  value: string | undefined = process.env.E2EE_ENABLED,
): boolean {
  if (value === undefined || value.trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}
