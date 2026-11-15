import { bootstrapE2ee, type BootstrapResult } from './bootstrap';
import { beginE2eeInit, classifyE2eeFailure, setE2eeInitState } from './initState';

/**
 * Exécute l'initialisation E2EE une seule fois à la fois.
 *
 * Le résultat n'est jamais perdu : une erreur fatale (base chiffrée ou Keystore
 * indisponible) est enregistrée comme `failed`, une publication de clés ratée
 * comme `degraded`. Aucun de ces cas ne produit un état `ready` : l'interface
 * doit voir la vérité, pas une initialisation supposée.
 */
interface InFlightInit {
  token: string;
  generation: number;
  promise: Promise<BootstrapResult | null>;
}

let inFlight: InFlightInit | null = null;

export function runE2eeInit(
  token: string,
  userId: string,
  options?: { force?: boolean },
): Promise<BootstrapResult | null> {
  if (inFlight?.token === token && !options?.force) return inFlight.promise;
  const generation = beginE2eeInit();
  const promise = (async (): Promise<BootstrapResult | null> => {
    setE2eeInitState({ status: 'pending' }, generation);
    try {
      const result = await bootstrapE2ee(token, userId);
      if (result.disabled) {
        setE2eeInitState({ status: 'idle' }, generation);
        return result;
      }
      if (result.error) {
        setE2eeInitState(
          { status: 'degraded', failure: classifyE2eeFailure(result.error) },
          generation,
        );
        return result;
      }
      setE2eeInitState({ status: 'ready' }, generation);
      return result;
    } catch (cause) {
      setE2eeInitState({ status: 'failed', failure: classifyE2eeFailure(cause) }, generation);
      return null;
    }
  })();
  const entry: InFlightInit = { token, generation, promise };
  inFlight = entry;
  void promise.finally(() => {
    if (inFlight === entry) inFlight = null;
  });
  return promise;
}
