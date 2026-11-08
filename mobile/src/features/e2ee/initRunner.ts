import { bootstrapE2ee, type BootstrapResult } from './bootstrap';
import { classifyE2eeFailure, setE2eeInitState } from './initState';

/**
 * Exécute l'initialisation E2EE une seule fois à la fois.
 *
 * Le résultat n'est jamais perdu : une erreur fatale (base chiffrée ou Keystore
 * indisponible) est enregistrée comme `failed`, une publication de clés ratée
 * comme `degraded`. Aucun de ces cas ne produit un état `ready` : l'interface
 * doit voir la vérité, pas une initialisation supposée.
 */
let inFlight: Promise<BootstrapResult | null> | null = null;

export function runE2eeInit(
  token: string,
  options?: { force?: boolean },
): Promise<BootstrapResult | null> {
  if (inFlight && !options?.force) return inFlight;
  inFlight = (async (): Promise<BootstrapResult | null> => {
    setE2eeInitState({ status: 'pending' });
    try {
      const result = await bootstrapE2ee(token);
      if (result.disabled) {
        setE2eeInitState({ status: 'idle' });
        return result;
      }
      if (result.error) {
        setE2eeInitState({ status: 'degraded', failure: classifyE2eeFailure(result.error) });
        return result;
      }
      setE2eeInitState({ status: 'ready' });
      return result;
    } catch (cause) {
      setE2eeInitState({ status: 'failed', failure: classifyE2eeFailure(cause) });
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
