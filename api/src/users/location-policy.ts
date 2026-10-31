/**
 * Politique de mise à jour de la ville : le serveur seul décide, à partir de
 * la position approximative. Une ville ne change pas plus d'une fois par
 * 24 heures, sauf déménagement notable (≥ 100 km) après 30 minutes ; un saut
 * de plusieurs centaines de kilomètres en quelques minutes est ignoré.
 */
export const CITY_REFRESH_MS = 24 * 60 * 60 * 1000;
export const MOVE_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const MOVE_MIN_DISTANCE_KM = 100;
export const TELEPORT_DISTANCE_KM = 300;

export type Coordinate = { latitude: number; longitude: number };

export type CityUpdateInput = {
  hasCity: boolean;
  oldCity: string | null;
  oldCountry: string | null;
  oldUpdatedAt: Date | null;
  newCity: string | null;
  newCountry: string | null;
  newCoords: Coordinate;
  oldCoords: Coordinate | null;
  now: Date;
};

export type CityUpdateDecision =
  | { accept: true; reason: 'first' | 'daily' | 'moved' }
  | { accept: false; reason: 'no-city' | 'same-city' | 'too-soon' | 'teleport' };

function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** ~1 km : suffisant pour une ville, inutile pour situer précisément quelqu'un. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundedCoordinates(coord: Coordinate): Coordinate {
  return {
    latitude: roundCoordinate(coord.latitude),
    longitude: roundCoordinate(coord.longitude),
  };
}

/** Distance orthodromique en kilomètres. */
export function distanceKm(a: Coordinate, b: Coordinate): number {
  const radius = 6371;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function evaluateCityUpdate(input: CityUpdateInput): CityUpdateDecision {
  if (!input.newCity) {
    return { accept: false, reason: 'no-city' };
  }
  if (!input.hasCity || !input.oldUpdatedAt) {
    return { accept: true, reason: 'first' };
  }
  if (
    normalize(input.oldCity) === normalize(input.newCity) &&
    normalize(input.oldCountry) === normalize(input.newCountry)
  ) {
    return { accept: false, reason: 'same-city' };
  }
  const elapsed = input.now.getTime() - input.oldUpdatedAt.getTime();
  if (elapsed >= CITY_REFRESH_MS) {
    return { accept: true, reason: 'daily' };
  }
  const distance = input.oldCoords
    ? distanceKm(input.oldCoords, input.newCoords)
    : Number.POSITIVE_INFINITY;
  // Sans coordonnées de référence, on ne peut pas distinguer un vrai
  // déménagement d'un saut : on attend le délai de 24 h.
  if (
    input.oldCoords &&
    elapsed >= MOVE_MIN_INTERVAL_MS &&
    distance >= MOVE_MIN_DISTANCE_KM
  ) {
    return { accept: true, reason: 'moved' };
  }
  return {
    accept: false,
    reason:
      input.oldCoords && distance >= TELEPORT_DISTANCE_KM ? 'teleport' : 'too-soon',
  };
}
